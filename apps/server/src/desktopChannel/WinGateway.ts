// @effect-diagnostics preferSchemaOverJson:off - NDJSON wire encoding.
import {
  DESKTOP_EXEC_GRANT_WAIT_MS,
  DESKTOP_EXEC_TIMEOUT_GRACE_MS,
  DESKTOP_EXEC_LOG_RETAINED,
  DESKTOP_EXEC_SUMMARY_MAX_CHARS,
  DesktopExecLogEntry,
  DesktopExecLogResult,
  DesktopExecProgress,
  DesktopExecResult,
  DesktopStatusResult,
  WinGatewayExecRequest,
  WIN_GATEWAY_PATH_PREFIX,
  WIN_GATEWAY_LABEL_HEADER,
  type WinGatewayExecLine,
  type WinGatewayStatusResponse,
  type WinGatewayLogResponse,
  type DesktopChannelHost,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as DesktopChannelBroker from "./DesktopChannelBroker.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

class WinGatewayError extends Schema.TaggedError<WinGatewayError>()("WinGatewayError", {
  code: Schema.String,
  message: Schema.String,
}) {}

type Invocation = { scope: McpInvocationScope; label?: string };
const errorLine = (error: {
  code: string;
  message: string;
  remoteCode?: string | undefined;
}): Extract<WinGatewayExecLine, { type: "error" }> => ({
  type: "error",
  code:
    error.code === "HOST_ERROR" && error.remoteCode
      ? error.remoteCode
      : error.code === "HOST_REPLACED"
        ? "HOST_DISCONNECTED"
        : error.code,
  message: error.message,
});
const decodeProgress = Schema.decodeUnknownEffect(Schema.fromJsonString(DesktopExecProgress));
const decodeExecRequest = Schema.decodeUnknownEffect(WinGatewayExecRequest, {
  onExcessProperty: "error",
});
const decodeLogEntries = Schema.decodeUnknownEffect(Schema.Array(DesktopExecLogEntry));
const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
const context = ({ scope, label }: Invocation) => ({
  threadId: scope.threadId,
  provider: scope.providerInstanceId,
  ...(label === undefined ? {} : { label }),
});
const execEnabled = (host: DesktopChannelHost) =>
  host.capabilities.enabled && host.capabilities.exec !== undefined;

export class WinGateway extends Context.Service<
  WinGateway,
  {
    readonly exec: (
      request: WinGatewayExecRequest,
      invocation: Invocation,
    ) => Stream.Stream<WinGatewayExecLine>;
    readonly status: (
      host: string | undefined,
      invocation: Invocation,
    ) => Effect.Effect<WinGatewayStatusResponse, WinGatewayError>;
    readonly log: (
      limit: number,
      host: string | undefined,
      invocation: Invocation,
    ) => Effect.Effect<WinGatewayLogResponse, WinGatewayError>;
  }
>()("t3/desktopChannel/WinGateway") {}

const make = Effect.gen(function* () {
  const broker = yield* DesktopChannelBroker.DesktopChannelBroker;
  const sql = yield* SqlClient.SqlClient;
  const bestEffort = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch((cause) => Effect.logWarning("Win audit write failed", { cause })),
    );
  const disabled = (hosts: ReadonlyArray<DesktopChannelHost>) =>
    new WinGatewayError({
      code: "HOST_DISABLED",
      message: `Enable remote operations in the T3 Windows desktop app on: ${hosts.map((h) => `${h.hostName} (${h.hostId})`).join(", ")}.`,
    });
  const select = Effect.fn("WinGateway.select")(function* (name?: string) {
    const connected = yield* broker.listHosts();
    if (name) {
      const exact = connected.find((h) => h.hostId === name);
      const matches = exact
        ? [exact]
        : connected.filter((h) => h.hostName.toLowerCase() === name.toLowerCase());
      if (!matches.length)
        return yield* new WinGatewayError({
          code: "HOST_NOT_FOUND",
          message: `Windows host not found: ${name}`,
        });
      if (matches.length > 1)
        return yield* new WinGatewayError({
          code: "HOST_AMBIGUOUS",
          message: matches.map((h) => `${h.hostName} (${h.hostId})`).join(", "),
        });
      const host = matches[0]!;
      if (!execEnabled(host)) return yield* disabled(matches);
      return host;
    }
    const hosts = connected.filter(execEnabled);
    if (!hosts.length) {
      if (connected.length) return yield* disabled(connected);
      return yield* new WinGatewayError({
        code: "HOST_OFFLINE",
        message: "No Windows host available.",
      });
    }
    if (hosts.length > 1)
      return yield* new WinGatewayError({
        code: "HOST_AMBIGUOUS",
        message: `Specify --host: ${hosts.map((h) => `${h.hostName} (${h.hostId})`).join(", ")}`,
      });
    return hosts[0]!;
  });
  const exec: WinGateway["Service"]["exec"] = (request, invocation) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const host = yield* select(request.host);
        const handle = yield* broker.invoke({
          hostId: host.hostId,
          kind: "exec",
          input: request.exec,
          timeoutMs:
            DESKTOP_EXEC_GRANT_WAIT_MS + request.exec.timeoutMs + DESKTOP_EXEC_TIMEOUT_GRACE_MS,
          context: context(invocation),
        });
        const startedAt = yield* now;
        const input = request.exec;
        const summary = (
          input.mode === "powershell"
            ? input.script
            : input.argv
                .map((arg) => (/\s|"/.test(arg) || !arg.length ? JSON.stringify(arg) : arg))
                .join(" ")
        ).slice(0, DESKTOP_EXEC_SUMMARY_MAX_CHARS);
        let finished = false;
        let winCwd = input.winCwd ?? null;
        const finish = Effect.fn("WinGateway.finish")(function* (line: WinGatewayExecLine) {
          if (finished) return;
          finished = true;
          const finishedAt = yield* now;
          const result = line.type === "result" ? line.result : undefined;
          yield* bestEffort(sql`UPDATE desktop_channel_audit SET finished_at=${finishedAt},
        outcome=${result?.outcome ?? (line.type === "error" && line.code === "CANCELLED" ? "cancelled" : "error")},
        exit_code=${result?.exitCode ?? null}, error_code=${line.type === "error" ? line.code : null},
        duration_ms=${result?.durationMs ?? null}, win_cwd=${result?.winCwd ?? winCwd}
        WHERE request_id=${handle.requestId}`);
        }, Effect.uninterruptible);
        yield* Effect.addFinalizer(() =>
          handle.cancel.pipe(
            Effect.andThen(
              finish({ type: "error", code: "CANCELLED", message: "Launcher disconnected." }),
            ),
          ),
        );
        yield* bestEffort(sql`INSERT INTO desktop_channel_audit
      (request_id, host_id, host_name, server_cwd, started_at, thread_id, provider, label, mode, summary, win_cwd, outcome)
      VALUES (${handle.requestId}, ${host.hostId}, ${host.hostName}, ${input.serverCwd}, ${startedAt}, ${invocation.scope.threadId}, ${invocation.scope.providerInstanceId}, ${invocation.label ?? null}, ${input.mode}, ${summary}, ${input.winCwd ?? null}, 'running')`).pipe(
          Effect.uninterruptible,
        );
        const events = handle.events.pipe(
          Stream.flatMap((batch) => Stream.fromIterable(batch.events)),
          Stream.mapEffect(
            Effect.fn("WinGateway.event")(function* (event): Effect.fn.Return<
              WinGatewayExecLine | undefined
            > {
              if (event.kind === "stdout" || event.kind === "stderr")
                return { type: event.kind, data: event.data };
              if (event.kind !== "progress") return;
              const progress = yield* decodeProgress(event.data).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Invalid desktop exec progress; dropping event", {
                    cause,
                  }).pipe(Effect.as(undefined)),
                ),
              );
              if (!progress) return;
              if (progress.type === "started") winCwd = progress.winCwd;
              return { type: "progress", progress };
            }),
          ),
          Stream.filter((line): line is WinGatewayExecLine => line !== undefined),
        );
        const terminal = Stream.fromEffect(
          handle.result.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DesktopExecResult)),
            Effect.map((result): WinGatewayExecLine => ({ type: "result", result })),
            Effect.catch((error) =>
              Effect.succeed(
                errorLine(
                  "code" in error
                    ? error
                    : { code: "INTERNAL", message: "Invalid desktop exec result." },
                ),
              ),
            ),
            Effect.tap(finish),
          ),
        );
        return Stream.succeed({
          type: "accepted",
          requestId: handle.requestId,
          hostId: host.hostId,
          hostName: host.hostName,
        } satisfies WinGatewayExecLine).pipe(Stream.concat(events), Stream.concat(terminal));
      }),
    ).pipe(Stream.catch((error) => Stream.make(errorLine(error))));

  const status: WinGateway["Service"]["status"] = Effect.fn("WinGateway.status")(
    function* (host, invocation) {
      const hosts = yield* broker.listHosts();
      const selected = yield* select(host).pipe(Effect.result);
      const response: WinGatewayStatusResponse = {
        threadId: invocation.scope.threadId,
        provider: invocation.scope.providerInstanceId,
        hosts: hosts.map((h) => ({
          hostId: h.hostId,
          hostName: h.hostName,
          platform: h.platform,
          appVersion: h.appVersion,
          connectedAt: DateTime.formatIso(DateTime.makeUnsafe(h.connectedAt)),
          execEnabled: execEnabled(h),
        })),
        selectedHostId: selected._tag === "Success" ? selected.success.hostId : null,
        hostStatus: null,
        hostStatusError: selected._tag === "Failure" ? selected.failure.code : null,
      };
      if (selected._tag === "Failure") return response;
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* broker.invoke({
            hostId: selected.success.hostId,
            kind: "status",
            input: {},
            timeoutMs: 10_000,
            context: context(invocation),
          });
          yield* Stream.runDrain(handle.events).pipe(Effect.forkScoped);
          return yield* handle.result.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(DesktopStatusResult)),
          );
        }),
      ).pipe(Effect.result);
      return result._tag === "Success"
        ? { ...response, hostStatus: result.success }
        : {
            ...response,
            hostStatusError: "code" in result.failure ? errorLine(result.failure).code : "INTERNAL",
          };
    },
  );

  const log: WinGateway["Service"]["log"] = Effect.fn("WinGateway.log")(
    function* (limit, host, invocation) {
      const selected = yield* select(host).pipe(Effect.result);
      if (selected._tag === "Success") {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* broker.invoke({
              hostId: selected.success.hostId,
              kind: "log",
              input: { limit },
              timeoutMs: 10_000,
              context: context(invocation),
            });
            yield* Stream.runDrain(handle.events).pipe(Effect.forkScoped);
            return yield* handle.result.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(DesktopExecLogResult)),
            );
          }),
        ).pipe(Effect.result);
        if (result._tag === "Success") return { source: "host", entries: result.success.entries };
        yield* Effect.logWarning("Could not read Windows execution log; using server audit", {
          hostId: selected.success.hostId,
          cause: result.failure,
        });
      } else if (
        selected.failure.code === "HOST_AMBIGUOUS" ||
        selected.failure.code === "HOST_DISABLED"
      ) {
        return yield* selected.failure;
      }
      const rows =
        yield* sql`SELECT request_id AS "requestId", started_at AS "startedAt", finished_at AS "finishedAt", thread_id AS "threadId", provider, label, mode, summary, win_cwd AS "winCwd", outcome, exit_code AS "exitCode", error_code AS "errorCode", duration_ms AS "durationMs"
      FROM desktop_channel_audit WHERE (${host ?? null} IS NULL OR host_id=${host ?? null} OR lower(host_name)=lower(${host ?? null})) ORDER BY started_at DESC, rowid DESC LIMIT ${limit}`.pipe(
          Effect.flatMap(decodeLogEntries),
          Effect.mapError(
            () =>
              new WinGatewayError({
                code: "INTERNAL",
                message: "Could not read server execution log.",
              }),
          ),
        );
      return { source: "server", entries: rows };
    },
  );
  return WinGateway.of({ exec, status, log });
});

export const layer = Layer.effect(WinGateway, make);

export const WIN_GATEWAY_HEARTBEAT_INTERVAL_MS = 30_000;

/** Blank lines keep quiet exec responses alive without adding protocol events. */
export const execResponseStream = (
  lines: Stream.Stream<WinGatewayExecLine>,
  heartbeatIntervalMs = WIN_GATEWAY_HEARTBEAT_INTERVAL_MS,
): Stream.Stream<Uint8Array> => {
  const encoder = new TextEncoder();
  const heartbeat = Stream.fromEffectRepeat(
    Effect.sleep(heartbeatIntervalMs).pipe(Effect.as(encoder.encode("\n"))),
  );
  return lines.pipe(
    Stream.map((line) => encoder.encode(`${JSON.stringify(line)}\n`)),
    Stream.merge(heartbeat, { haltStrategy: "left" }),
  );
};

const ndjson = (line: WinGatewayExecLine, status = 200) =>
  HttpServerResponse.text(`${JSON.stringify(line)}\n`, {
    status,
    contentType: "application/x-ndjson",
    headers: { "cache-control": "no-store", "content-type": "application/x-ndjson" },
  });
const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const authorization = request.headers.authorization;
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  const scope = yield* registry.resolve(token);
  if (!scope?.capabilities.has("win"))
    return ndjson(
      {
        type: "error",
        code: "UNAUTHORIZED",
        message: "A valid session credential with win access is required.",
      },
      401,
    );
  const gateway = yield* WinGateway;
  const label = request.headers[WIN_GATEWAY_LABEL_HEADER]?.slice(0, 200);
  const invocation = { scope, ...(label === undefined ? {} : { label }) };
  const url = new URL(request.url, "http://localhost");
  const host = url.searchParams.get("host") ?? undefined;
  if (request.method === "POST" && url.pathname === `${WIN_GATEWAY_PATH_PREFIX}/exec`) {
    const decoded = yield* request.json.pipe(Effect.flatMap(decodeExecRequest), Effect.result);
    if (decoded._tag === "Failure")
      return ndjson({ type: "error", code: "BAD_REQUEST", message: "Invalid exec request." });
    return HttpServerResponse.stream(
      execResponseStream(gateway.exec(decoded.success, invocation)),
      {
        contentType: "application/x-ndjson",
        headers: { "cache-control": "no-store", "content-type": "application/x-ndjson" },
      },
    );
  }
  if (request.method === "GET" && url.pathname === `${WIN_GATEWAY_PATH_PREFIX}/status`)
    return yield* gateway.status(host, invocation).pipe(
      Effect.map(HttpServerResponse.jsonUnsafe),
      Effect.catch((error) => Effect.succeed(ndjson(errorLine(error)))),
    );
  if (request.method === "GET" && url.pathname === `${WIN_GATEWAY_PATH_PREFIX}/log`) {
    const raw = url.searchParams.get("n") ?? "20";
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || n < 1 || n > DESKTOP_EXEC_LOG_RETAINED)
      return ndjson({
        type: "error",
        code: "BAD_REQUEST",
        message: `n must be between 1 and ${DESKTOP_EXEC_LOG_RETAINED}.`,
      });
    return yield* gateway.log(n, host, invocation).pipe(
      Effect.map(HttpServerResponse.jsonUnsafe),
      Effect.catch((error) => Effect.succeed(ndjson(errorLine(error)))),
    );
  }
  return ndjson({ type: "error", code: "BAD_REQUEST", message: "Unknown win route." });
});

export const routes = Layer.unwrap(
  Effect.gen(function* () {
    const gateway = yield* WinGateway;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    return HttpRouter.add(
      "*",
      `${WIN_GATEWAY_PATH_PREFIX}/*`,
      handler.pipe(
        Effect.provideService(WinGateway, gateway),
        Effect.provideService(McpSessionRegistry.McpSessionRegistry, registry),
      ),
    );
  }),
).pipe(Layer.provide(layer));
