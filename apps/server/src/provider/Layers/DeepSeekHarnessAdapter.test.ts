import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DeepSeekHarnessSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionRuntime, AcpSessionRuntimeEvent } from "../acp/AcpSessionRuntime.ts";
import {
  deepSeekModelValue,
  makeDeepSeekHarnessAdapter,
  permissionOptionId,
  permissionOptions,
} from "./DeepSeekHarnessAdapter.ts";

const officialFlash = JSON.stringify(["deepseek-official", "deepseek-v4-flash"]);
const officialPro = JSON.stringify(["deepseek-official", "deepseek-v4-pro"]);
const otherPro = JSON.stringify(["another-provider", "deepseek-v4-pro"]);
const decodeSettings = Schema.decodeEffect(DeepSeekHarnessSettings);
const configOptions = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: officialFlash,
    options: [
      {
        group: "deepseek-official",
        name: "DeepSeek",
        options: [
          { value: officialFlash, name: "DeepSeek V4 Flash" },
          { value: officialPro, name: "DeepSeek V4 Pro" },
        ],
      },
      {
        group: "another-provider",
        name: "Other provider",
        options: [{ value: otherPro, name: "Other provider Pro" }],
      },
    ],
  },
] satisfies ReadonlyArray<EffectAcpSchema.SessionConfigOption>;

it("selects an official DeepSeek model using the ACP route advertised by the harness", () => {
  expect(deepSeekModelValue(configOptions, "deepseek-v4-pro")).toBe(officialPro);
  expect(deepSeekModelValue(configOptions, "deepseek-v4-flash")).toBe(officialFlash);
  expect(deepSeekModelValue(configOptions, otherPro)).toBe(otherPro);
  expect(deepSeekModelValue(configOptions, "unknown-model")).toBeUndefined();
});

it("offers only permission decisions supported by the harness", () => {
  const request = {
    options: [
      { optionId: "yes-once", name: "Allow once", kind: "allow_once" },
      { optionId: "no-once", name: "Reject", kind: "reject_once" },
    ],
  } satisfies Pick<EffectAcpSchema.RequestPermissionRequest, "options">;
  expect(permissionOptionId(request, "accept")).toBe("yes-once");
  expect(permissionOptionId(request, "acceptForSession")).toBeUndefined();
  expect(permissionOptionId(request, "acceptAlways")).toBeUndefined();
  expect(permissionOptionId(request, "decline")).toBe("no-once");
  expect(permissionOptionId(request, "cancel")).toBeUndefined();
  expect(permissionOptions(request).map((option) => option.decision)).toEqual([
    "accept",
    "decline",
    "cancel",
  ]);
  const withAlways = {
    options: [
      ...request.options,
      { optionId: "yes-always", name: "Allow always", kind: "allow_always" },
    ],
  } satisfies Pick<EffectAcpSchema.RequestPermissionRequest, "options">;
  expect(permissionOptionId(withAlways, "acceptAlways")).toBe("yes-always");
  expect(permissionOptions(withAlways).map((option) => option.decision)).toEqual([
    "accept",
    "acceptForSession",
    "decline",
    "cancel",
  ]);
});

it.effect("resumes an ACP session and streams a turn with the selected model and reasoning", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("deepseek-test");
    const threadId = ThreadId.make("deepseek-thread");
    const nativeSessionId = "native-deepseek-session";
    const launches: Array<string | undefined> = [];
    const prompts: string[] = [];
    const observed: ProviderRuntimeEvent[] = [];
    const completed = yield* Deferred.make<void>();
    const runtimeEvents = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    let permissionHandler:
      | Parameters<AcpSessionRuntime["Service"]["handleRequestPermission"]>[0]
      | undefined;
    let model = officialFlash;
    let reasoning = "high";
    const options = (): ReadonlyArray<EffectAcpSchema.SessionConfigOption> => [
      { ...configOptions[0]!, currentValue: model },
      {
        id: "reasoning_effort",
        name: "Reasoning",
        type: "select",
        currentValue: reasoning,
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      },
    ];
    const runtime = {
      handleRequestPermission: (
        handler: Parameters<AcpSessionRuntime["Service"]["handleRequestPermission"]>[0],
      ) => Effect.sync(() => void (permissionHandler = handler)),
      start: () =>
        Effect.succeed({
          sessionId: nativeSessionId,
          initializeResult: { protocolVersion: 1, agentCapabilities: {} },
          sessionSetupResult: { sessionId: nativeSessionId, configOptions: options() },
          modelConfigId: "model",
        }),
      getConfigOptions: Effect.sync(options),
      setModel: (value: string) => Effect.sync(() => void (model = value)),
      setConfigOption: (_id: string, value: string | boolean) =>
        Effect.sync(() => {
          reasoning = String(value);
          return { configOptions: options() };
        }),
      getEvents: () => Stream.fromQueue(runtimeEvents),
      drainEvents: Effect.gen(function* () {
        const acknowledge = yield* Deferred.make<void>();
        yield* Queue.offer(runtimeEvents, { _tag: "EventStreamBarrier", acknowledge });
        yield* Deferred.await(acknowledge);
      }),
      prompt: (input: { prompt: ReadonlyArray<EffectAcpSchema.ContentBlock> }) =>
        Effect.gen(function* () {
          prompts.push(input.prompt[0]?.type === "text" ? input.prompt[0].text : "");
          yield* Queue.offer(runtimeEvents, {
            _tag: "ContentDelta",
            text: "DeepSeek reply",
            rawPayload: {},
          });
          return { stopReason: "end_turn" as const };
        }),
      cancel: Effect.void,
    };
    const adapter = yield* makeDeepSeekHarnessAdapter({
      instanceId,
      settings: yield* decodeSettings({ enabled: true }),
      makeRuntime: ({ resumeSessionId }) =>
        Effect.sync(() => {
          launches.push(resumeSessionId);
          return runtime;
        }),
    });
    yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          observed.push(event);
          if (event.type === "turn.completed") yield* Deferred.succeed(completed, undefined);
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    const first = yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      modelSelection: {
        instanceId,
        model: "deepseek-v4-pro",
        options: [{ id: "reasoningEffort", value: "low" }],
      },
    });
    expect(model).toBe(officialPro);
    expect(reasoning).toBe("low");
    if (!permissionHandler) throw new Error("Missing permission handler");
    const approval = yield* permissionHandler({
      sessionId: nativeSessionId,
      toolCall: { toolCallId: "write-1", kind: "edit", title: "Write file" },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Allow always", kind: "allow_always" },
      ],
    });
    expect(approval).toEqual({ outcome: { outcome: "selected", optionId: "once" } });
    yield* adapter.stopSession(threadId);
    const resumed = yield* adapter.startSession({
      threadId,
      cwd: process.cwd(),
      runtimeMode: "approval-required",
      resumeCursor: first.resumeCursor,
    });
    expect(launches).toEqual([undefined, nativeSessionId]);
    expect(resumed.resumeCursor).toEqual(first.resumeCursor);
    expect(resumed.model).toBe("deepseek-v4-pro");
    yield* adapter.sendTurn({ threadId, input: "Hello" });
    yield* Deferred.await(completed);
    expect(prompts[0]).toContain("Hello");
    expect(observed.some((event) => event.type === "content.delta")).toBe(true);
    expect(observed.some((event) => event.type === "turn.completed")).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
