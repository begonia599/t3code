import * as NodeCrypto from "node:crypto";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Broker from "./DesktopChannelBroker.ts";
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
      expect(yield* Fiber.join(call)).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining(`[${code}]`) }],
      });
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
      const ninth = yield* relay.call(session, "unity__inspect", {}).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      expect(yield* h.queued).toBe(0);
      yield* Fiber.interrupt(ninth);
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
