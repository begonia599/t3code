import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DesktopChannelHost,
  type DesktopChannelStreamEvent,
  WinGatewayExecLine,
  DesktopExecLogEntry,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Logger from "effect/Logger";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as DesktopChannelBroker from "./DesktopChannelBroker.ts";
import * as WinGateway from "./WinGateway.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});
const hostId = "91d581f4-d87a-4efe-967c-2b60314575bb";
const secondHostId = "a9fe42d0-a35a-4b65-90ec-ea9094b84936";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("e"),
  threadId: ThreadId.make("thread"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "session",
  capabilities: new Set(["win"]),
  issuedAt: 0,
};
const host: DesktopChannelHost = {
  hostId,
  hostName: "Windows Work",
  platform: "win32",
  appVersion: "1",
  environmentId: scope.environmentId,
  capabilities: { enabled: true, exec: { version: "1", shells: ["pwsh"] } },
};
const exec = {
  mode: "argv",
  argv: ["echo", "hello world"],
  serverCwd: "/project",
  env: {},
  timeoutMs: 2000,
  noSync: false,
};
const result = {
  outcome: "exited",
  exitCode: 4,
  durationMs: 10,
  winCwd: "C:\\project",
  stdoutBytes: 5,
  stderrBytes: 0,
  truncated: false,
  decodedAsGbk: false,
};
const hostStatus = {
  enabled: true,
  strictMode: false,
  grant: "granted",
  allowlist: ["C:\\project"],
  mappings: [],
  running: 0,
  shells: ["pwsh"],
};
const decodeExecLine = Schema.decodeUnknownEffect(Schema.fromJsonString(WinGatewayExecLine));
const decodeLogEntry = Schema.decodeUnknownSync(DesktopExecLogEntry);
const lines = (text: string): WinGatewayExecLine[] =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

async function fixture(eventBufferCapacity = 256) {
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Own the broker and SQLite lifetime across Promise-based HTTP handlers and reader cancellation.
  const runtime = ManagedRuntime.make(
    WinGateway.layer.pipe(
      Layer.provideMerge(
        DesktopChannelBroker.layer.pipe(
          Layer.provide(
            Layer.succeed(DesktopChannelBroker.DesktopChannelBrokerOptions, {
              maxInFlightPerHost: 16,
              eventBufferCapacity,
            }),
          ),
        ),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    ),
  );
  disposers.push(() => runtime.dispose());
  const broker = await runtime.runPromise(DesktopChannelBroker.DesktopChannelBroker);
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const gateway = await runtime.runPromise(WinGateway.WinGateway);
  const registry: McpSessionRegistry.McpSessionRegistryShape = {
    issue: () => Effect.die("unused"),
    resolve: (token) =>
      Effect.succeed(
        token === "win"
          ? scope
          : token === "no-win"
            ? { ...scope, capabilities: new Set() }
            : undefined,
      ),
    touch: () => Effect.void,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  };
  const { handler, dispose } = HttpRouter.toWebHandler(
    WinGateway.routes.pipe(
      Layer.provide(Layer.succeed(DesktopChannelBroker.DesktopChannelBroker, broker)),
      Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
      Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  const startHost = async (description = host) => {
    const ready = await runtime.runPromise(Deferred.make<string>());
    const inbox = await runtime.runPromise(
      Queue.unbounded<Exclude<DesktopChannelStreamEvent, { type: "connected" }>>(),
    );
    const stream = await runtime.runPromise(
      broker.connect(description, { subject: "owner", sessionId: AuthSessionId.make("auth") }),
    );
    const fiber = runtime.runFork(
      Stream.runForEach(stream, (message) =>
        message.type === "connected"
          ? Deferred.succeed(ready, message.connectionId)
          : Queue.offer(inbox, message),
      ),
    );
    const connectionId = await runtime.runPromise(Deferred.await(ready));
    const identity = { hostId: description.hostId, connectionId };
    const stop = () => runtime.runPromise(Fiber.interrupt(fiber));
    disposers.push(stop);
    const next = () => runtime.runPromise(Queue.take(inbox));
    return {
      identity,
      next,
      stop,
      emit: (
        requestId: string,
        seq: number,
        events: { kind: "stdout" | "stderr" | "progress"; data: string }[],
      ) => runtime.runPromise(broker.emit({ ...identity, requestId, seq, events })),
      respond: (requestId: string, value: unknown) =>
        runtime.runPromise(broker.respond({ ...identity, requestId, ok: true, result: value })),
      error: (requestId: string, code: string) =>
        runtime.runPromise(
          broker.respond({
            ...identity,
            requestId,
            ok: false,
            error: { code, message: "host error" },
          }),
        ),
    };
  };
  const request = (
    path: string,
    options: { token?: string; body?: unknown; label?: string; signal?: AbortSignal } = {},
  ) =>
    handler(
      new Request(`http://t3.test/agent-win/v1/${path}`, {
        method: options.body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${options.token ?? "win"}`,
          "content-type": "application/json",
          ...(options.label ? { "x-t3-win-label": options.label } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
  const audit = () =>
    runtime.runPromise(sql`SELECT * FROM desktop_channel_audit ORDER BY rowid DESC`);
  return { runtime, broker, gateway, sql, startHost, request, audit };
}

describe("WinGateway over real DesktopChannelBroker", () => {
  it.each(["expired", "no-win", ""])("requires a win credential (%s)", async (token) => {
    const f = await fixture();
    const res = await f.request("exec", { body: { exec }, token });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(lines(await res.text())).toMatchObject([{ type: "error", code: "UNAUTHORIZED" }]);
  });
  it("selects zero, one and multiple eligible hosts, and resolves names or ids", async () => {
    const f = await fixture();
    const invoke = async (target?: string) => {
      const res = await f.request("exec", { body: { exec, ...(target ? { host: target } : {}) } });
      return res;
    };
    expect(lines(await (await invoke()).text())).toMatchObject([{ code: "HOST_OFFLINE" }]);
    await f.startHost({ ...host, capabilities: { enabled: true } });
    expect(lines(await (await invoke()).text())).toMatchObject([{ code: "HOST_DISABLED" }]);
    const first = await f.startHost();
    const res = await invoke();
    const text = res.text();
    const message = await first.next();
    expect(message.type).toBe("request");
    await first.respond(message.requestId, result);
    expect(lines(await text)[0]).toMatchObject({ type: "accepted", hostId });
    const second = await f.startHost({ ...host, hostId: secondHostId, hostName: "Other" });
    const ambiguous = lines(await (await invoke()).text());
    expect(ambiguous).toMatchObject([{ code: "HOST_AMBIGUOUS" }]);
    expect(JSON.stringify(ambiguous)).toContain(secondHostId);
    expect(lines(await (await invoke("missing")).text())).toMatchObject([
      { code: "HOST_NOT_FOUND" },
    ]);
    for (const name of ["oThEr", secondHostId]) {
      const res = await invoke(name);
      const text = res.text();
      const req = await second.next();
      await second.respond(req.requestId, result);
      expect(lines(await text)[0]).toMatchObject({ hostId: secondHostId });
    }
  });
  it("streams accepted, stdout, stderr and decoded progress before result, and updates its audit", async () => {
    const f = await fixture();
    const h = await f.startHost();
    const response = await f.request("exec", { body: { exec }, label: "x".repeat(250) });
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(lines(new TextDecoder().decode(first.value))).toMatchObject([{ type: "accepted" }]);
    const request = await h.next();
    expect(request).toMatchObject({
      type: "request",
      kind: "exec",
      timeoutMs: 152000,
      context: { threadId: "thread", provider: "codex", label: "x".repeat(200) },
    });
    expect(await f.audit()).toMatchObject([
      {
        outcome: "running",
        summary: 'echo "hello world"',
        server_cwd: "/project",
        host_name: "Windows Work",
      },
    ]);
    await h.emit(request.requestId, 0, [
      { kind: "stdout", data: "hello" },
      { kind: "stderr", data: "warning" },
      { kind: "progress", data: '{"type":"awaiting-grant"}' },
      { kind: "progress", data: '{"type":"wrong"}' },
    ]);
    await h.respond(request.requestId, result);
    let text = "";
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    expect(lines(text)).toEqual([
      { type: "stdout", data: "hello" },
      { type: "stderr", data: "warning" },
      { type: "progress", progress: { type: "awaiting-grant" } },
      { type: "result", result },
    ]);
    expect(await f.audit()).toMatchObject([
      {
        outcome: "exited",
        exit_code: 4,
        win_cwd: "C:\\project",
        duration_ms: 10,
        error_code: null,
        label: "x".repeat(200),
      },
    ]);
    expect((await f.audit())[0]!.finished_at).toBeTruthy();
  });
  it.each(["GRANT_DENIED", "CWD_NOT_ALLOWED", "SPAWN_NOT_FOUND"])(
    "passes desktop error %s through and audits it",
    async (code) => {
      const f = await fixture();
      const h = await f.startHost();
      const res = await f.request("exec", { body: { exec } });
      const text = res.text();
      const req = await h.next();
      await h.error(req.requestId, code);
      expect(lines(await text)[1]).toEqual({ type: "error", code, message: "host error" });
      expect(await f.audit()).toMatchObject([{ outcome: "error", error_code: code }]);
    },
  );
  it.each([false, true])(
    "reports HOST_DISCONNECTED when a host disconnects/reconnects (%s)",
    async (replace) => {
      const f = await fixture();
      const h = await f.startHost();
      const res = await f.request("exec", { body: { exec } });
      const text = res.text();
      await h.next();
      if (replace) await f.startHost();
      else await h.stop();
      expect(lines(await text)[1]).toMatchObject({ type: "error", code: "HOST_DISCONNECTED" });
      expect(await f.audit()).toMatchObject([
        { outcome: "error", error_code: "HOST_DISCONNECTED" },
      ]);
    },
  );
  it("cancels the broker request when the HTTP client closes its output stream", async () => {
    const f = await fixture();
    const h = await f.startHost();
    const res = await f.request("exec", { body: { exec } });
    const reader = res.body!.getReader();
    await reader.read();
    const req = await h.next();
    await reader.cancel();
    expect(await h.next()).toEqual({ type: "cancel", requestId: req.requestId });
    expect(await f.audit()).toMatchObject([{ outcome: "cancelled", error_code: "CANCELLED" }]);
  });
  it("rejects bad inputs and invalid results", async () => {
    const f = await fixture();
    expect(lines(await (await f.request("exec", { body: { exec: {} } })).text())).toMatchObject([
      { code: "BAD_REQUEST" },
    ]);
    expect(lines(await (await f.request("log?n=201")).text())).toMatchObject([
      { code: "BAD_REQUEST" },
    ]);
    expect(
      lines(
        await (
          await f.request("exec", { body: { exec: { ...exec, env: { "invalid-key": "x" } } } })
        ).text(),
      ),
    ).toMatchObject([{ code: "BAD_REQUEST" }]);
    const h = await f.startHost();
    const res = await f.request("exec", { body: { exec } });
    const text = res.text();
    const req = await h.next();
    await h.respond(req.requestId, {});
    expect(lines(await text)[1]).toMatchObject({ code: "INTERNAL" });
  });
  it("gets status from an online host, reports host errors, and describes offline state", async () => {
    const f = await fixture();
    expect(await (await f.request("status")).json()).toMatchObject({
      hosts: [],
      selectedHostId: null,
      hostStatusError: "HOST_OFFLINE",
    });
    const h = await f.startHost();
    const pending = f.request("status");
    const req = await h.next();
    expect(req).toMatchObject({ type: "request", kind: "status", timeoutMs: 10000 });
    await h.respond(req.requestId, hostStatus);
    expect(await (await pending).json()).toMatchObject({
      selectedHostId: hostId,
      hostStatus,
      hostStatusError: null,
    });
    const failed = f.request("status");
    const req2 = await h.next();
    await h.error(req2.requestId, "REMOTE_DISABLED");
    expect(await (await failed).json()).toMatchObject({
      hostStatus: null,
      hostStatusError: "REMOTE_DISABLED",
    });
  });
  it("reads logs from the host while online, then uses newest-first server audit when offline", async () => {
    const f = await fixture();
    const h = await f.startHost();
    const entry = decodeLogEntry({
      requestId: "remote",
      startedAt: "now",
      finishedAt: null,
      threadId: null,
      provider: null,
      label: null,
      mode: "argv",
      summary: "echo",
      winCwd: null,
      outcome: "running",
      exitCode: null,
      errorCode: null,
      durationMs: null,
    });
    const online = f.request("log?n=5");
    const logReq = await h.next();
    expect(logReq).toMatchObject({ kind: "log", input: { limit: 5 } });
    await h.respond(logReq.requestId, { entries: [entry] });
    expect(await (await online).json()).toEqual({ source: "host", entries: [entry] });
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const res = await f.request("exec", {
        body: {
          exec: {
            mode: "powershell",
            script: "X".repeat(600),
            serverCwd: exec.serverCwd,
            env: {},
            timeoutMs: exec.timeoutMs,
            noSync: false,
          },
        },
      });
      const text = res.text();
      const req = await h.next();
      ids.push(req.requestId);
      await h.respond(req.requestId, result);
      await text;
    }
    await h.stop();
    const offline = await (await f.request("log?n=1")).json();
    expect(offline).toMatchObject({
      source: "server",
      entries: [{ requestId: ids[1], summary: "X".repeat(500), outcome: "exited" }],
    });
    expect(offline.entries).toHaveLength(1);
    expect(await (await f.request(`log?host=${secondHostId}`)).json()).toEqual({
      source: "server",
      entries: [],
    });
  });
  it("does not interrupt execution when audit writes fail", async () => {
    const f = await fixture();
    const h = await f.startHost();
    await f.runtime.runPromise(f.sql`DROP TABLE desktop_channel_audit`);
    const res = await f.request("exec", { body: { exec } });
    const text = res.text();
    const req = await h.next();
    await h.respond(req.requestId, result);
    expect(lines(await text).at(-1)).toEqual({ type: "result", result });
  });
  it("propagates a slow output consumer back to the broker and releases blocked emits on cancellation", async () => {
    const f = await fixture(1);
    const h = await f.startHost();
    const paused = await f.runtime.runPromise(Deferred.make<void>());
    const resume = await f.runtime.runPromise(Deferred.make<void>());
    const attempting = await f.runtime.runPromise(Deferred.make<void>());
    const completed = await f.runtime.runPromise(Deferred.make<void>());
    const consumer = f.runtime.runFork(
      Stream.runForEach(f.gateway.exec({ exec: { ...exec, mode: "argv" } }, { scope }), (line) =>
        line.type === "stdout"
          ? Deferred.succeed(paused, undefined).pipe(Effect.andThen(Deferred.await(resume)))
          : Effect.void,
      ),
    );
    const request = await h.next();
    const events = [{ kind: "stdout" as const, data: "output" }];
    await h.emit(request.requestId, 0, events);
    await f.runtime.runPromise(Deferred.await(paused));
    await h.emit(request.requestId, 1, events);
    const producer = f.runtime.runFork(
      Deferred.succeed(attempting, undefined).pipe(
        Effect.andThen(
          f.broker.emit({ ...h.identity, requestId: request.requestId, seq: 2, events }),
        ),
        Effect.andThen(Deferred.succeed(completed, undefined)),
      ),
    );
    await f.runtime.runPromise(Deferred.await(attempting));
    expect(await f.runtime.runPromise(Deferred.isDone(completed))).toBe(false);
    await f.runtime.runPromise(Fiber.interrupt(consumer));
    expect(await h.next()).toEqual({ type: "cancel", requestId: request.requestId });
    await f.runtime.runPromise(Fiber.join(producer));
    expect(await f.runtime.runPromise(Deferred.isDone(completed))).toBe(true);
  });
  it.each([{ enabled: false, exec: { version: "1", shells: ["pwsh"] } }, { enabled: true }])(
    "reports HOST_DISABLED across exec/status/log for connected hosts without exec (%j)",
    async (capabilities) => {
      const f = await fixture();
      await f.startHost({ ...host, capabilities });
      for (const selector of [undefined, hostId, "wInDoWs WoRk"]) {
        const suffix = selector ? `?host=${encodeURIComponent(selector)}` : "";
        const execError = lines(
          await (
            await f.request("exec", { body: { exec, ...(selector ? { host: selector } : {}) } })
          ).text(),
        );
        expect(execError).toMatchObject([{ type: "error", code: "HOST_DISABLED" }]);
        expect(JSON.stringify(execError)).toContain("T3 Windows desktop app");
        expect(await (await f.request(`status${suffix}`)).json()).toMatchObject({
          selectedHostId: null,
          hostStatusError: "HOST_DISABLED",
        });
        expect(await (await f.request(`log${suffix}`)).json()).toMatchObject({
          type: "error",
          code: "HOST_DISABLED",
        });
      }
      await f.startHost({ ...host, hostId: secondHostId, hostName: "Enabled" });
      // An enabled alternative must not override an explicitly selected disabled host.
      expect(
        lines(await (await f.request("exec", { body: { exec, host: hostId } })).text()),
      ).toMatchObject([{ code: "HOST_DISABLED" }]);
    },
  );

  it.each(["UNSUPPORTED_KIND", "invalid-result", "disconnect"])(
    "falls back to persisted audit when online host log fails (%s)",
    async (failure) => {
      const f = await fixture();
      const h = await f.startHost();
      const response = await f.request("exec", { body: { exec } });
      const text = response.text();
      const executed = await h.next();
      await h.respond(executed.requestId, result);
      await text;
      const log = f.request(`log?host=${hostId}`);
      const request = await h.next();
      if (failure === "disconnect") await h.stop();
      else if (failure === "invalid-result") await h.respond(request.requestId, {});
      else await h.error(request.requestId, failure);
      expect(await (await log).json()).toMatchObject({
        source: "server",
        entries: [{ requestId: executed.requestId, outcome: "exited", exitCode: 4 }],
      });
    },
  );
});

effectIt.effect.each([1_000, WinGateway.WIN_GATEWAY_HEARTBEAT_INTERVAL_MS])(
  "emits blank heartbeats during quiet exec and stops them with the terminal line (%i ms)",
  (interval) =>
    Effect.scoped(
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        const output = yield* Queue.unbounded<string>();
        const accepted: WinGatewayExecLine = {
          type: "accepted",
          hostId,
          hostName: host.hostName,
          requestId: "heartbeat",
        };
        const terminal: WinGatewayExecLine = {
          type: "result",
          result: { ...result, outcome: "exited" },
        };
        const main = Stream.succeed(accepted).pipe(
          Stream.concat(Stream.fromEffect(Deferred.await(done).pipe(Effect.as(terminal)))),
        );
        const stream =
          interval === WinGateway.WIN_GATEWAY_HEARTBEAT_INTERVAL_MS
            ? WinGateway.execResponseStream(main)
            : WinGateway.execResponseStream(main, interval);
        const fiber = yield* Stream.runForEach(stream, (chunk) =>
          Queue.offer(output, new TextDecoder().decode(chunk)),
        ).pipe(Effect.forkScoped);
        expect(yield* decodeExecLine(yield* Queue.take(output))).toEqual(accepted);
        yield* TestClock.adjust(interval - 1);
        expect(yield* Queue.size(output)).toBe(0);
        yield* TestClock.adjust(1);
        expect(yield* Queue.take(output)).toBe("\n");
        yield* TestClock.adjust(interval);
        expect(yield* Queue.take(output)).toBe("\n");
        yield* Deferred.succeed(done, undefined);
        yield* Fiber.join(fiber);
        expect(yield* decodeExecLine(yield* Queue.take(output))).toEqual(terminal);
        yield* TestClock.adjust(3 * interval);
        expect(yield* Queue.size(output)).toBe(0);
      }),
    ),
);

effectIt.effect(
  "falls back to server audit with a warning when the host log request times out",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* DesktopChannelBroker.DesktopChannelBroker;
        const gateway = yield* WinGateway.WinGateway;
        const connected = yield* Deferred.make<void>();
        const requested = yield* Deferred.make<void>();
        yield* Stream.runForEach(
          yield* broker.connect(host, { subject: "owner", sessionId: AuthSessionId.make("auth") }),
          (message) =>
            message.type === "connected"
              ? Deferred.succeed(connected, undefined)
              : message.type === "request"
                ? Deferred.succeed(requested, undefined)
                : Effect.void,
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        const warnings: unknown[] = [];
        const fiber = yield* gateway.log(20, undefined, { scope }).pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([
              Logger.make(({ message }) => {
                warnings.push(message);
              }),
            ]),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(requested);
        yield* TestClock.adjust(10_000);
        expect(yield* Fiber.join(fiber)).toEqual({ source: "server", entries: [] });
        expect(warnings).toHaveLength(1);
      }),
    ).pipe(
      Effect.provide(
        WinGateway.layer.pipe(
          Layer.provideMerge(DesktopChannelBroker.layer),
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
);
