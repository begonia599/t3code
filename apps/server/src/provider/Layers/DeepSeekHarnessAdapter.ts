import {
  ApprovalRequestId,
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  TurnId,
  type DeepSeekHarnessSettings,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";
import * as EffectAcpErrors from "effect-acp/errors";

import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import {
  collectSessionConfigOptionValues,
  parsePermissionRequest,
} from "../acp/AcpRuntimeModel.ts";
import type { AcpSessionRuntime, AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const DRIVER = ProviderDriverKind.make("deepseekHarness");
const isAcpError = Schema.is(EffectAcpErrors.AcpError);
const decodeModelRoute = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);
const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
type Adapter = ProviderAdapterShape<ProviderAdapterError>;
type Runtime = Pick<
  AcpSessionRuntime["Service"],
  | "handleRequestPermission"
  | "start"
  | "getConfigOptions"
  | "setModel"
  | "setConfigOption"
  | "getEvents"
  | "drainEvents"
  | "prompt"
  | "cancel"
>;
type Permission = EffectAcpSchema.RequestPermissionRequest;
type PermissionResponse = EffectAcpSchema.RequestPermissionResponse;

interface SessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: Runtime;
  readonly nativeSessionId: string;
  readonly turnLock: Semaphore.Semaphore;
  readonly closed: Deferred.Deferred<void>;
  readonly approvals: Map<
    ApprovalRequestId,
    {
      request: Permission;
      reply: Deferred.Deferred<{ decision: ProviderApprovalDecision; result: PermissionResponse }>;
    }
  >;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  activeTurnId: TurnId | undefined;
  promptFiber: Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError> | undefined;
  stopped: boolean;
}

function resumeSessionId(value: unknown): string | undefined {
  const cursor = decodeResumeCursor(value);
  return Option.isSome(cursor) ? cursor.value.sessionId : undefined;
}

export function permissionOptionId(
  request: Pick<Permission, "options">,
  decision: ProviderApprovalDecision,
) {
  if (decision === "cancel") return undefined;
  const kind =
    decision === "acceptForSession" || decision === "acceptAlways"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  return request.options.find((option) => option.kind === kind && option.optionId.trim())?.optionId;
}

export function permissionOptions(request: Pick<Permission, "options">): ProviderApprovalOption[] {
  const options: ProviderApprovalOption[] = [];
  if (permissionOptionId(request, "accept")) {
    options.push({ decision: "accept", label: "Allow once" });
  }
  if (permissionOptionId(request, "acceptForSession")) {
    options.push({ decision: "acceptForSession", label: "Allow for this thread" });
  }
  if (permissionOptionId(request, "decline")) {
    options.push({ decision: "decline", label: "Deny" });
  }
  options.push({ decision: "cancel", label: "Cancel" });
  return options;
}

export function deepSeekModelValue(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  requestedModel: string,
): string | undefined {
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption) return undefined;
  return collectSessionConfigOptionValues(modelOption).find((value) => {
    if (value === requestedModel) return true;
    const route = decodeModelRoute(value);
    return (
      Option.isSome(route) &&
      route.value[1] === requestedModel &&
      route.value[0] === "deepseek-official"
    );
  });
}

function currentDeepSeekModel(configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>) {
  const value = configOptions.find((option) => option.category === "model")?.currentValue;
  if (typeof value !== "string") return undefined;
  const route = decodeModelRoute(value);
  return Option.isSome(route) && route.value[0] === "deepseek-official" ? route.value[1] : value;
}

const selectModel = Effect.fn("DeepSeekHarnessAdapter.selectModel")(function* (
  runtime: Runtime,
  requestedModel: string,
) {
  const configOptions = yield* runtime.getConfigOptions;
  const modelOption = configOptions.find((option) => option.category === "model");
  if (!modelOption) {
    return yield* new ProviderAdapterValidationError({
      provider: DRIVER,
      operation: "selectModel",
      issue: "DeepSeek Harness did not advertise a model selector.",
    });
  }
  const modelValue = deepSeekModelValue(configOptions, requestedModel);
  if (!modelValue) {
    return yield* new ProviderAdapterValidationError({
      provider: DRIVER,
      operation: "selectModel",
      issue: `Model '${requestedModel}' is unavailable in this DeepSeek Harness profile.`,
    });
  }
  if (modelValue !== modelOption.currentValue) yield* runtime.setModel(modelValue);
});

const selectReasoningEffort = Effect.fn("DeepSeekHarnessAdapter.selectReasoningEffort")(function* (
  runtime: Runtime,
  effort: string | undefined,
) {
  if (!effort) return;
  const option = (yield* runtime.getConfigOptions).find((entry) => entry.id === "reasoning_effort");
  if (!option || !collectSessionConfigOptionValues(option).includes(effort)) {
    return yield* new ProviderAdapterValidationError({
      provider: DRIVER,
      operation: "selectReasoningEffort",
      issue: `Reasoning effort '${effort}' is unavailable in this DeepSeek Harness profile.`,
    });
  }
  if (option.currentValue !== effort) yield* runtime.setConfigOption("reasoning_effort", effort);
});

export const makeDeepSeekHarnessAdapter = Effect.fn("makeDeepSeekHarnessAdapter")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly settings: DeepSeekHarnessSettings;
    readonly makeRuntime: (options: {
      readonly cwd: string;
      readonly resumeSessionId?: string;
      readonly mcpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
    }) => Effect.Effect<Runtime, EffectAcpErrors.AcpError, Scope.Scope>;
  }): Effect.fn.Return<Adapter, never, Crypto.Crypto | Scope.Scope> {
    const crypto = yield* Crypto.Crypto;
    const ownerScope = yield* Scope.Scope;
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionContext>();
    const startLock = yield* Semaphore.make(1);
    const randomId = crypto.randomUUIDv4.pipe(Effect.orDie);
    const stamp = Effect.gen(function* () {
      return {
        eventId: EventId.make(yield* randomId),
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
    });
    const emit = (event: ProviderRuntimeEvent) => PubSub.publish(events, event);
    const requireSession = (threadId: ThreadId) =>
      Effect.sync(() => sessions.get(threadId)).pipe(
        Effect.filterOrFail(
          (context): context is SessionContext => context !== undefined && !context.stopped,
          () => new ProviderAdapterSessionNotFoundError({ provider: DRIVER, threadId }),
        ),
      );
    const stopContext = (context: SessionContext, disconnected = false) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        yield* Deferred.succeed(context.closed, undefined);
        for (const pending of context.approvals.values()) {
          yield* Deferred.succeed(pending.reply, {
            decision: "cancel",
            result: { outcome: { outcome: "cancelled" } },
          });
        }
        context.approvals.clear();
        if (context.promptFiber) yield* Effect.ignore(context.runtime.cancel);
        yield* Scope.close(context.scope, Exit.void);
        if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
        yield* emit({
          type: "session.exited",
          ...(yield* stamp),
          provider: DRIVER,
          threadId: context.threadId,
          payload: {
            exitKind: disconnected ? "error" : "graceful",
            ...(disconnected ? { reason: "DeepSeek Harness process stopped." } : {}),
          },
        });
      });

    const handlePermission = (context: SessionContext, request: Permission) =>
      Effect.gen(function* (): Effect.fn.Return<PermissionResponse> {
        if (context.stopped || request.sessionId !== context.nativeSessionId) {
          return { outcome: { outcome: "cancelled" } };
        }
        const parsed = parsePermissionRequest(request);
        const optionId =
          context.session.runtimeMode === "full-access" ||
          (context.session.runtimeMode === "auto-accept-edits" &&
            ["edit", "delete", "move"].includes(parsed.kind))
            ? (permissionOptionId(request, "accept") ??
              permissionOptionId(request, "acceptForSession"))
            : undefined;
        if (optionId) return { outcome: { outcome: "selected", optionId } };
        const requestId = ApprovalRequestId.make(yield* randomId);
        const reply = yield* Deferred.make<{
          decision: ProviderApprovalDecision;
          result: PermissionResponse;
        }>();
        context.approvals.set(requestId, { request, reply });
        return yield* Effect.gen(function* () {
          yield* emit(
            makeAcpRequestOpenedEvent({
              stamp: yield* stamp,
              provider: DRIVER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              requestId: RuntimeRequestId.make(requestId),
              permissionRequest: parsed,
              approvalOptions: permissionOptions(request),
              detail: parsed.detail ?? "DeepSeek Harness requests permission.",
              args: request.toolCall,
              source: "acp.jsonrpc",
              method: "session/request_permission",
              rawPayload: request,
            }),
          );
          const answer = yield* Deferred.await(reply);
          yield* emit(
            makeAcpRequestResolvedEvent({
              stamp: yield* stamp,
              provider: DRIVER,
              threadId: context.threadId,
              turnId: context.activeTurnId,
              requestId: RuntimeRequestId.make(requestId),
              permissionRequest: parsed,
              decision: answer.decision,
            }),
          );
          return answer.result;
        }).pipe(Effect.ensuring(Effect.sync(() => context.approvals.delete(requestId))));
      });

    const handleEvent = (context: SessionContext, event: AcpSessionRuntimeEvent) =>
      Effect.gen(function* () {
        if (event._tag === "EventStreamBarrier") {
          yield* Deferred.succeed(event.acknowledge, undefined);
          return;
        }
        if (context.stopped) return;
        if (event._tag === "ConnectionTerminated") {
          yield* stopContext(context, true).pipe(Effect.forkIn(ownerScope));
          return;
        }
        const base = {
          stamp: yield* stamp,
          provider: DRIVER,
          threadId: context.threadId,
          turnId: context.activeTurnId,
        };
        switch (event._tag) {
          case "AssistantItemStarted":
          case "AssistantItemCompleted":
            yield* emit(
              makeAcpAssistantItemEvent({
                ...base,
                itemId: event.itemId,
                lifecycle:
                  event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
              }),
            );
            break;
          case "ContentDelta":
          case "ThoughtDelta":
            yield* emit(
              makeAcpContentDeltaEvent({
                ...base,
                text: event.text,
                rawPayload: event.rawPayload,
                ...(event._tag === "ContentDelta" && event.itemId ? { itemId: event.itemId } : {}),
                ...(event._tag === "ThoughtDelta" ? { streamKind: "reasoning_text" as const } : {}),
              }),
            );
            break;
          case "ToolCallUpdated":
            yield* emit(
              makeAcpToolCallEvent({
                ...base,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            break;
          case "PlanUpdated":
            yield* emit(
              makeAcpPlanUpdatedEvent({
                ...base,
                payload: event.payload,
                source: "acp.jsonrpc",
                method: "session/update",
                rawPayload: event.rawPayload,
              }),
            );
            break;
        }
      });

    const startSession: Adapter["startSession"] = (request) =>
      startLock.withPermit(
        Effect.gen(function* () {
          if (!input.settings.enabled || !request.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER,
              operation: "startSession",
              issue: "Enable DeepSeek Harness and select a workspace before starting a thread.",
            });
          }
          if (request.provider && request.provider !== DRIVER) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER,
              operation: "startSession",
              issue: "The selected provider does not match DeepSeek Harness.",
            });
          }
          if (request.providerInstanceId && request.providerInstanceId !== input.instanceId) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER,
              operation: "startSession",
              issue: "The provider instance does not match this session.",
            });
          }
          if (request.modelSelection && request.modelSelection.instanceId !== input.instanceId) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER,
              operation: "startSession",
              issue: "The selected model belongs to another provider instance.",
            });
          }
          const previous = sessions.get(request.threadId);
          if (previous) yield* stopContext(previous);
          const cursor = resumeSessionId(request.resumeCursor);
          if (request.resumeCursor !== undefined && !cursor) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER,
              operation: "startSession",
              issue: "The saved DeepSeek Harness session is invalid.",
            });
          }
          const scope = yield* Scope.make("sequential");
          const setup = Effect.gen(function* () {
            const mcp = McpProviderSession.readMcpProviderSession(request.threadId);
            const runtime = yield* input.makeRuntime({
              cwd: request.cwd!,
              ...(cursor ? { resumeSessionId: cursor } : {}),
              mcpServers: mcp
                ? [
                    {
                      type: "http",
                      name: "t3-code",
                      url: mcp.endpoint,
                      headers: [{ name: "Authorization", value: mcp.authorizationHeader }],
                    },
                  ]
                : [],
            });
            let context: SessionContext | undefined;
            yield* runtime.handleRequestPermission((permission) =>
              context
                ? handlePermission(context, permission)
                : Effect.succeed({ outcome: { outcome: "cancelled" } }),
            );
            const started = yield* runtime.start();
            const createdAt = DateTime.formatIso(yield* DateTime.now);
            const model =
              request.modelSelection?.model ??
              currentDeepSeekModel(yield* runtime.getConfigOptions) ??
              "deepseek-v4-flash";
            if (request.modelSelection) yield* selectModel(runtime, model);
            yield* selectReasoningEffort(
              runtime,
              getModelSelectionStringOptionValue(request.modelSelection, "reasoningEffort"),
            );
            const session: ProviderSession = {
              provider: DRIVER,
              providerInstanceId: input.instanceId,
              threadId: request.threadId,
              cwd: request.cwd!,
              status: "ready",
              runtimeMode: request.runtimeMode,
              model,
              resumeCursor: { schemaVersion: 1, sessionId: started.sessionId },
              createdAt,
              updatedAt: createdAt,
            };
            context = {
              threadId: request.threadId,
              scope,
              runtime,
              nativeSessionId: started.sessionId,
              turnLock: yield* Semaphore.make(1),
              closed: yield* Deferred.make<void>(),
              approvals: new Map(),
              turns: [],
              session,
              activeTurnId: undefined,
              promptFiber: undefined,
              stopped: false,
            };
            sessions.set(request.threadId, context);
            const active = context;
            yield* Stream.runForEach(runtime.getEvents(), (event) =>
              handleEvent(active, event),
            ).pipe(Effect.forkIn(scope));
            yield* emit({
              type: "session.started",
              ...(yield* stamp),
              provider: DRIVER,
              threadId: request.threadId,
              payload: { resume: started.initializeResult },
            });
            yield* emit({
              type: "thread.started",
              ...(yield* stamp),
              provider: DRIVER,
              threadId: request.threadId,
              payload: { providerThreadId: started.sessionId },
            });
            yield* Effect.race(runtime.drainEvents, Deferred.await(active.closed));
            if (active.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: DRIVER,
                threadId: request.threadId,
              });
            }
            return session;
          }).pipe(Effect.provideService(Scope.Scope, scope));
          return yield* setup.pipe(
            Effect.mapError((error) =>
              isAcpError(error)
                ? mapAcpToAdapterError(DRIVER, request.threadId, "session/new", error)
                : error,
            ),
            Effect.tapError(() =>
              Effect.gen(function* () {
                yield* Scope.close(scope, Exit.void);
                sessions.delete(request.threadId);
              }),
            ),
          );
        }),
      );

    const sendTurn: Adapter["sendTurn"] = (request) =>
      Effect.gen(function* () {
        const context = yield* requireSession(request.threadId);
        return yield* context.turnLock.withPermit(
          Effect.gen(function* () {
            if (request.modelSelection && request.modelSelection.instanceId !== input.instanceId) {
              return yield* new ProviderAdapterValidationError({
                provider: DRIVER,
                operation: "sendTurn",
                issue: "The selected model belongs to another provider instance.",
              });
            }
            const model = request.modelSelection?.model ?? context.session.model;
            if (model && model !== context.session.model)
              yield* selectModel(context.runtime, model);
            yield* selectReasoningEffort(
              context.runtime,
              getModelSelectionStringOptionValue(request.modelSelection, "reasoningEffort"),
            );
            const turnId = TurnId.make(yield* randomId);
            context.activeTurnId = turnId;
            context.session = {
              ...context.session,
              status: "running",
              activeTurnId: turnId,
              ...(model ? { model } : {}),
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* emit({
              type: "turn.started",
              ...(yield* stamp),
              provider: DRIVER,
              threadId: request.threadId,
              turnId,
              payload: model ? { model } : {},
            });
            const prompt = context.runtime.prompt({
              prompt: [
                {
                  type: "text",
                  text: `${request.input ?? ""}\n\n${buildRuntimeInstructions({ harness: "DeepSeek Harness", model })}`,
                },
              ],
            });
            const fiber = yield* prompt.pipe(Effect.forkIn(context.scope));
            context.promptFiber = fiber;
            const outcome = yield* Fiber.await(fiber);
            yield* Effect.race(context.runtime.drainEvents, Deferred.await(context.closed));
            if (context.stopped) {
              return yield* new ProviderAdapterSessionNotFoundError({
                provider: DRIVER,
                threadId: request.threadId,
              });
            }
            context.promptFiber = undefined;
            context.activeTurnId = undefined;
            const result = Exit.isSuccess(outcome) ? outcome.value : undefined;
            if (result) context.turns.push({ id: turnId, items: [result] });
            context.session = {
              ...context.session,
              status: Exit.isSuccess(outcome) ? "ready" : "error",
              activeTurnId: undefined,
              updatedAt: DateTime.formatIso(yield* DateTime.now),
            };
            yield* emit({
              type: "turn.completed",
              ...(yield* stamp),
              provider: DRIVER,
              threadId: request.threadId,
              turnId,
              payload: {
                state:
                  result?.stopReason === "cancelled"
                    ? "cancelled"
                    : result
                      ? "completed"
                      : "failed",
                ...(result
                  ? { stopReason: result.stopReason }
                  : { errorMessage: "DeepSeek Harness turn failed." }),
              },
            });
            if (Exit.isFailure(outcome)) {
              return yield* new ProviderAdapterRequestError({
                provider: DRIVER,
                method: "session/prompt",
                detail: "DeepSeek Harness turn failed.",
              });
            }
            return {
              threadId: request.threadId,
              turnId,
              resumeCursor: context.session.resumeCursor,
            };
          }),
        );
      }).pipe(
        Effect.mapError((error) =>
          isAcpError(error)
            ? mapAcpToAdapterError(DRIVER, request.threadId, "session/prompt", error)
            : error,
        ),
      );

    const stopSession: Adapter["stopSession"] = (threadId) =>
      Effect.flatMap(requireSession(threadId), (context) => stopContext(context));
    const stopAll: Adapter["stopAll"] = () =>
      Effect.forEach([...sessions.values()], (context) => stopContext(context), { discard: true });
    yield* Effect.addFinalizer(() =>
      stopAll().pipe(Effect.ensuring(PubSub.shutdown(events)), Effect.ignore),
    );

    return {
      provider: DRIVER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn: (threadId) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          yield* Effect.ignore(context.runtime.cancel);
        }),
      respondToRequest: (threadId, requestId, decision) =>
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          const pending = context.approvals.get(requestId);
          if (!pending)
            return yield* new ProviderAdapterRequestError({
              provider: DRIVER,
              method: "session/request_permission",
              detail: "This permission request is no longer pending.",
            });
          const optionId = permissionOptionId(pending.request, decision);
          if (decision !== "cancel" && !optionId) {
            return yield* new ProviderAdapterValidationError({
              provider: DRIVER,
              operation: "respondToRequest",
              issue: "DeepSeek Harness did not offer this permission choice.",
            });
          }
          yield* Deferred.succeed(pending.reply, {
            decision,
            result: {
              outcome: optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" },
            },
          });
        }),
      respondToUserInput: (_threadId, _requestId, _answers) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: DRIVER,
            operation: "respondToUserInput",
            issue: "DeepSeek Harness ACP does not support user input requests.",
          }),
        ),
      stopSession,
      stopAll,
      listSessions: () =>
        Effect.sync(() =>
          [...sessions.values()]
            .filter((context) => !context.stopped)
            .map((context) => context.session),
        ),
      hasSession: (threadId) =>
        Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
      readThread: (threadId) =>
        Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
      rollbackThread: (_threadId, _numTurns) =>
        Effect.fail(
          new ProviderAdapterValidationError({
            provider: DRIVER,
            operation: "rollbackThread",
            issue: "DeepSeek Harness ACP does not support conversation rewind.",
          }),
        ),
      streamEvents: Stream.fromPubSub(events),
    } satisfies Adapter;
  },
);
