import * as NodeCrypto from "node:crypto";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Broker from "./DesktopChannelBroker.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Relay from "./WinMcpRelay.ts";
import { host, scope, startHost, testLayer, toolResult } from "./winMcpTestHelpers.ts";

it.effect(
  "aggregates definitions, truncates names, deterministically resolves natural/hash collisions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const long = "x".repeat(80);
        const short = `${long.slice(0, 38)}_${NodeCrypto.createHash("sha256").update(`unity__${long}`).digest("hex").slice(0, 6)}`;
        const server = host.capabilities.mcp!.servers[0]!;
        const tools = [
          server.tools[0]!,
          ...[long, short, "scene.get", "scene_get"].map((name) => ({
            name,
            inputSchema: { type: "object" },
          })),
        ];
        const h = yield* startHost({
          ...host,
          capabilities: { enabled: true, mcp: { version: "1", servers: [{ ...server, tools }] } },
        });
        const relay = yield* Relay.WinMcpRelay;
        const session = yield* relay.open(scope);
        const first = yield* relay.list(session);
        expect(first.tools).toHaveLength(5);
        expect(new Set(first.tools.map((t) => t.name)).size).toBe(5);
        expect(first.tools.every((t) => `mcp__t3-win__${t.name}`.length <= 64)).toBe(true);
        expect(first.tools.every((t) => /^[A-Za-z0-9_-]+$/.test(t.name))).toBe(true);
        expect(first.tools.map((t) => t.name)).toContain("unity__scene_get");
        expect(first.tools.map((t) => t.name)).toContainEqual(
          expect.stringMatching(/^unity__scene_get_[0-9a-f]{6}$/),
        );
        expect(first.tools.find((t) => t.name === "unity__inspect")).toMatchObject({
          ...server.tools[0],
          name: "unity__inspect",
          description: "[Windows · Unity] Read scene",
        });
        yield* h.update({
          enabled: true,
          mcp: { version: "2", servers: [{ ...server, tools: tools.toReversed() }] },
        });
        expect((yield* relay.list(session)).fingerprint).toBe(first.fingerprint);
        yield* h.update({
          enabled: true,
          mcp: { version: "2", servers: [{ ...server, status: "failed", tools: [] }] },
        });
        expect((yield* relay.list(session)).fingerprint).toBe(first.fingerprint);
        yield* h.stop;
        expect((yield* relay.list(session)).fingerprint).toBe(first.fingerprint);
      }),
    ).pipe(Effect.provide(testLayer())),
);

it.effect(
  "binds a later host, retains offline hosts and never switches an established session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const relay = yield* Relay.WinMcpRelay;
        const session = yield* relay.open(scope);
        expect((yield* relay.list(session)).tools).toEqual([]);
        const h = yield* startHost();
        expect((yield* relay.list(session)).tools).toHaveLength(1);
        yield* h.stop;
        yield* startHost({ ...host, hostId: "other", hostName: "Other" });
        expect((yield* relay.list(session)).tools).toHaveLength(1);
        expect(session.hostId).toBe(host.hostId);
        expect(yield* relay.call(session, "unity__inspect", {})).toMatchObject({
          isError: true,
          content: [{ text: expect.stringContaining("Work PC 不在线") }],
        });
        expect((yield* relay.list(yield* relay.open(scope))).tools).toHaveLength(0);
      }),
    ).pipe(Effect.provide(testLayer())),
);

it.effect("prefers the project link even when only another host is available", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* startHost({ ...host, hostId: "other" });
      const relay = yield* Relay.WinMcpRelay;
      const session = yield* relay.open(scope);
      expect(session.hostId).toBe(host.hostId);
      expect((yield* relay.list(session)).tools).toHaveLength(0);
      yield* startHost();
      const call = yield* relay.call(session, "unity__inspect", {}).pipe(Effect.forkScoped);
      yield* Fiber.interrupt(call);
      expect(session.context).toMatchObject({ projectId: "project", linkedHostId: host.hostId });
    }),
  ).pipe(Effect.provide(testLayer(true))),
);

it.effect("maps calls, forwards progress, preserves tool errors, and cancels the broker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const relay = yield* Relay.WinMcpRelay;
      const session = yield* relay.open(scope);
      const progressed = yield* Deferred.make<unknown>();
      const call = yield* relay
        .call(session, "unity__inspect", { scene: 1 }, (value) => {
          Deferred.doneUnsafe(progressed, Effect.succeed(value));
          return Promise.resolve();
        })
        .pipe(Effect.forkScoped);
      const request = yield* h.next;
      if (request.type !== "request") throw new Error("Expected request");
      expect(request).toMatchObject({
        kind: "mcp.call",
        timeoutMs: 122000,
        input: { serverId: "unity", toolName: "inspect", arguments: { scene: 1 } },
        context: { threadId: "thread", provider: "codex", projectId: "project" },
      });
      yield* h.progress(request.requestId);
      expect(yield* Deferred.await(progressed)).toEqual({
        progress: 1,
        total: 2,
        message: "working",
      });
      yield* h.respond(request.requestId, toolResult);
      expect(yield* Fiber.join(call)).toEqual(toolResult);
      const cancelled = yield* relay.call(session, "unity__inspect", {}).pipe(Effect.forkScoped);
      const next = yield* h.next;
      yield* Fiber.interrupt(cancelled);
      expect(yield* h.next).toEqual({ type: "cancel", requestId: next.requestId });
    }),
  ).pipe(Effect.provide(testLayer())),
);

it.effect(
  "keeps each session's audit label in broker context, including absent and empty labels",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* startHost();
        const relay = yield* Relay.WinMcpRelay;
        const first = yield* relay.open(scope, "task-a");
        const second = yield* relay.open(scope, "task-b");
        const unlabeled = yield* relay.open(scope);
        const empty = yield* relay.open(scope, "");
        for (const [session, label] of [
          [first, "task-a"],
          [second, "task-b"],
          [unlabeled, undefined],
          [empty, ""],
          [first, "task-a"],
          [second, "task-b"],
        ] as const) {
          const call = yield* relay.call(session, "unity__inspect", {}).pipe(Effect.forkScoped);
          const request = yield* h.next;
          if (request.type !== "request") throw new Error("Expected request");
          expect(request.context).toEqual({
            threadId: scope.threadId,
            provider: scope.providerInstanceId,
            projectId: "project",
            workspaceRoot: "/project",
            ...(label === undefined ? {} : { label }),
          });
          yield* h.respond(request.requestId, toolResult);
          expect(yield* Fiber.join(call)).toEqual(toolResult);
        }
      }),
    ).pipe(Effect.provide(testLayer())),
);

it.effect.each([
  "BAD_REQUEST",
  "REMOTE_DISABLED",
  "CANCELLED",
  "TIMEOUT",
  "MCP_SERVER_NOT_FOUND",
  "MCP_SERVER_DISABLED",
  "MCP_SERVER_UNAVAILABLE",
  "MCP_TOOL_NOT_FOUND",
  "MCP_PROTOCOL_ERROR",
  "MCP_RESULT_TOO_LARGE",
  "HOST_OFFLINE",
  "HOST_DISCONNECTED",
  "HOST_DISABLED",
  "HOST_BUSY",
  "UNEXPECTED",
])("explains desktop error %s", (code) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const relay = yield* Relay.WinMcpRelay;
      const call = yield* relay
        .call(yield* relay.open(scope), "unity__inspect", {})
        .pipe(Effect.forkScoped);
      const request = yield* h.next;
      yield* h.error(request.requestId, code);
      const result = yield* Fiber.join(call);
      expect(result).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining(`[${code}]`) }],
      });
      if (code === "MCP_SERVER_UNAVAILABLE") {
        expect(result.content).toMatchObject([
          {
            text: expect.stringContaining(
              "Windows 电脑 Work PC 上的 MCP 服务暂时不可用（可能没启动或正在重启），几秒后重试；一直失败请在 T3 桌面版「本机 MCP 服务器」里查看状态。",
            ),
          },
        ]);
      }
    }),
  ).pipe(Effect.provide(testLayer())),
);

it.effect("queues the ninth call and bounds the queue by cancellation and deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const relay = yield* Relay.WinMcpRelay;
      const session = yield* relay.open(scope);
      const calls = [];
      const requests = [];
      for (let i = 0; i < 8; i++) {
        calls.push(yield* relay.call(session, "unity__inspect", {}).pipe(Effect.forkScoped));
        requests.push(yield* h.next);
      }
      const queuedSession = yield* relay.open(scope, "queued-cancel");
      const ninth = yield* relay.call(queuedSession, "unity__inspect", {}).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(yield* h.queued).toBe(0);
      yield* Fiber.interrupt(ninth);
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT outcome, error_code FROM desktop_channel_audit WHERE label='queued-cancel'`,
      ).toEqual([{ outcome: "cancelled", error_code: "CANCELLED" }]);
      yield* h.respond(requests[0]!.requestId, toolResult);
      yield* Fiber.join(calls[0]!);
      expect(yield* h.queued).toBe(0);
      const next = yield* relay.call(session, "unity__inspect", {}).pipe(Effect.forkScoped);
      const request = yield* h.next;
      yield* TestClock.adjust(122000);
      expect(yield* Fiber.join(next)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("TIMEOUT") }],
      });
      expect(request.type).toBe("request");
    }),
  ).pipe(Effect.provide(testLayer())),
);

it.effect("queues the ninth call until a host permit is released", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const relay = yield* Relay.WinMcpRelay;
      const session = yield* relay.open(scope);
      const requests = [];
      for (let i = 0; i < 8; i++) {
        yield* relay.call(session, "unity__inspect", { i }).pipe(Effect.forkScoped);
        requests.push(yield* h.next);
      }
      const ninth = yield* relay.call(session, "unity__inspect", { i: 8 }).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(yield* h.queued).toBe(0);
      yield* h.respond(requests[0]!.requestId, toolResult);
      const request = yield* h.next;
      expect(request).toMatchObject({ input: { arguments: { i: 8 } } });
      yield* h.respond(request.requestId, toolResult);
      expect(yield* Fiber.join(ninth)).toEqual(toolResult);
    }),
  ).pipe(Effect.provide(testLayer())),
);

it.effect("publishes broker connection/update/disconnection and retains last capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* Broker.DesktopChannelBroker;
      const events = yield* Queue.unbounded<unknown>();
      yield* Stream.runForEach(broker.hostChanges, (event) => Queue.offer(events, event)).pipe(
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      const h = yield* startHost();
      expect(yield* Queue.take(events)).toEqual(host);
      const capabilities = { ...host.capabilities, enabled: false };
      yield* h.update(capabilities);
      expect(yield* Queue.take(events)).toEqual({ ...host, capabilities });
      yield* h.stop;
      expect(yield* Queue.take(events)).toEqual({ ...host, capabilities });
      expect(yield* broker.getLastCapabilities(host.hostId)).toEqual(capabilities);
      expect(yield* broker.listHosts()).toHaveLength(0);
      expect(yield* broker.listKnownHosts()).toEqual([{ ...host, capabilities }]);
    }),
  ).pipe(Effect.provide(testLayer())),
);

it.effect.each([
  "success",
  "tool-error",
  "cancelled",
  "disconnect",
  "replaced",
  "disabled",
  "protocol",
  "error",
  "timeout",
  "remote-timeout",
] as const)("audits MCP %s once without arguments or results", (mode) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const relay = yield* Relay.WinMcpRelay;
      const sql = yield* SqlClient.SqlClient;
      const session = yield* relay.open(scope, "audit-label");
      const call = yield* relay
        .call(session, "unity__inspect", { secret: "not-recorded" })
        .pipe(Effect.forkScoped);
      const request = yield* h.next;
      expect(yield* sql`SELECT * FROM desktop_channel_audit`).toMatchObject([
        {
          host_id: host.hostId,
          host_name: host.hostName,
          server_cwd: "/project",
          thread_id: scope.threadId,
          provider: scope.providerInstanceId,
          label: "audit-label",
          summary: "unity__inspect",
          mode: "mcp",
          outcome: "running",
          win_cwd: null,
          exit_code: null,
        },
      ]);
      if (mode === "cancelled") yield* Fiber.interrupt(call);
      else {
        if (mode === "disconnect") yield* h.stop;
        else if (mode === "replaced") yield* startHost();
        else if (mode === "disabled") yield* h.update({ ...host.capabilities, enabled: false });
        else if (mode === "error") yield* h.error(request.requestId, "MCP_SERVER_DISABLED");
        else if (mode === "timeout") yield* TestClock.adjust(122000);
        else if (mode === "remote-timeout") yield* h.error(request.requestId, "TIMEOUT");
        else
          yield* h.respond(
            request.requestId,
            mode === "protocol"
              ? { content: "invalid" }
              : {
                  content: [{ type: "text", text: "not-recorded" }],
                  isError: mode === "tool-error",
                },
          );
        yield* Fiber.join(call);
      }
      const rows = yield* sql`SELECT * FROM desktop_channel_audit`;
      expect(rows).toHaveLength(1);
      const expected = {
        success: ["exited", null],
        "tool-error": ["exited", "MCP_TOOL_ERROR"],
        cancelled: ["cancelled", "CANCELLED"],
        disconnect: ["unknown", "HOST_DISCONNECTED"],
        replaced: ["unknown", "HOST_REPLACED"],
        disabled: ["unknown", "HOST_DISCONNECTED"],
        protocol: ["error", "MCP_PROTOCOL_ERROR"],
        error: ["error", "MCP_SERVER_DISABLED"],
        timeout: ["timedOut", "TIMEOUT"],
        "remote-timeout": ["timedOut", "TIMEOUT"],
      }[mode];
      expect(rows).toMatchObject([
        {
          outcome: expected[0],
          error_code: expected[1],
          finished_at: expect.any(String),
          duration_ms: expect.any(Number),
          exit_code: null,
          win_cwd: null,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain("not-recorded");
    }),
  ).pipe(Effect.provide(testLayer())),
);

it.effect("audits without a project using an empty server cwd and known session context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const relay = yield* Relay.WinMcpRelay;
      const sql = yield* SqlClient.SqlClient;
      const call = yield* relay
        .call(yield* relay.open(scope), "unity__inspect", {})
        .pipe(Effect.forkScoped);
      const request = yield* h.next;
      yield* h.respond(request.requestId, { content: [] });
      yield* Fiber.join(call);
      expect(
        yield* sql`SELECT server_cwd, thread_id, provider, label FROM desktop_channel_audit`,
      ).toEqual([
        {
          server_cwd: "",
          thread_id: scope.threadId,
          provider: scope.providerInstanceId,
          label: null,
        },
      ]);
    }),
  ).pipe(Effect.provide(testLayer(false, false))),
);

it.effect("audits a host disabled before dispatch as a policy error", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const relay = yield* Relay.WinMcpRelay;
      const sql = yield* SqlClient.SqlClient;
      const session = yield* relay.open(scope);
      yield* h.update({ ...host.capabilities, enabled: false });
      expect(yield* relay.call(session, "unity__inspect", {})).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("[HOST_DISABLED]") }],
      });
      expect(yield* h.queued).toBe(0);
      expect(yield* sql`SELECT outcome, error_code FROM desktop_channel_audit`).toEqual([
        { outcome: "error", error_code: "HOST_DISABLED" },
      ]);
    }),
  ).pipe(Effect.provide(testLayer())),
);
