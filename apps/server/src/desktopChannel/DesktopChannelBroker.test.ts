import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  DesktopChannelCapabilities,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  WsRpcGroup,
  type DesktopChannelEmit,
  type DesktopChannelHost,
  type DesktopChannelStreamEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import * as DesktopChannelBroker from "./DesktopChannelBroker.ts";

const decodeCapabilities = Schema.decodeUnknownEffect(DesktopChannelCapabilities);
const encodeCapabilities = Schema.encodeEffect(DesktopChannelCapabilities);

const hostId = "91d581f4-d87a-4efe-967c-2b60314575bb";
const secondHostId = "a9fe42d0-a35a-4b65-90ec-ea9094b84936";
const auth = { subject: "desktop-owner", sessionId: AuthSessionId.make("session-1") };
const makeHost = (overrides: Partial<DesktopChannelHost> = {}): DesktopChannelHost => ({
  hostId,
  hostName: "Windows workstation",
  platform: "win32",
  appVersion: "1.0.0",
  environmentId: EnvironmentId.make("environment-1"),
  capabilities: { enabled: true },
  ...overrides,
});

const makeBroker = Effect.service(DesktopChannelBroker.DesktopChannelBroker).pipe(
  Effect.provide(DesktopChannelBroker.layer.pipe(Layer.provide(NodeServices.layer))),
);

const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.match(effect, {
    onFailure: (error) => error,
    onSuccess: () => expect.fail("Expected effect to fail"),
  });

type HostMessage = Exclude<DesktopChannelStreamEvent, { type: "connected" }>;

const startHost = Effect.fnUntraced(function* (
  broker: DesktopChannelBroker.DesktopChannelBroker["Service"],
  host = makeHost(),
) {
  const connected = yield* Deferred.make<string>();
  const inbox = yield* Queue.unbounded<HostMessage>();
  const consumer = yield* Stream.runForEach(yield* broker.connect(host, auth), (message) =>
    message.type === "connected"
      ? Deferred.succeed(connected, message.connectionId)
      : Queue.offer(inbox, message),
  ).pipe(Effect.forkScoped);
  const connectionId = yield* Deferred.await(connected);
  return { hostId: host.hostId, connectionId, inbox, consumer };
});

const invoke = (broker: DesktopChannelBroker.DesktopChannelBroker["Service"], target?: string) =>
  broker.invoke({ ...(target === undefined ? {} : { hostId: target }), kind: "ping", input: {} });

const batch = (
  host: { hostId: string; connectionId: string },
  requestId: string,
  seq = 0,
): DesktopChannelEmit => ({
  hostId: host.hostId,
  connectionId: host.connectionId,
  requestId,
  seq,
  events: [{ kind: "stdout", data: `batch ${seq}` }],
});

it.effect(
  "resolves explicit and unique enabled hosts, and reports offline, ambiguous and disabled",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        expect(yield* invoke(broker).pipe(failure)).toMatchObject({ code: "HOST_OFFLINE" });
        expect(yield* invoke(broker, hostId).pipe(failure)).toMatchObject({
          code: "HOST_OFFLINE",
        });
        const disabled = yield* startHost(broker, makeHost({ capabilities: { enabled: false } }));
        expect(yield* invoke(broker, hostId).pipe(failure)).toMatchObject({
          code: "HOST_DISABLED",
        });
        expect(yield* invoke(broker).pipe(failure)).toMatchObject({ code: "HOST_OFFLINE" });
        const second = yield* startHost(broker, makeHost({ hostId: secondHostId }));
        const unique = yield* invoke(broker);
        expect(unique.hostId).toBe(secondHostId);
        expect(yield* Queue.take(second.inbox)).toMatchObject({
          type: "request",
          requestId: unique.requestId,
        });
        yield* unique.cancel;
        yield* broker.updateCapabilities({ ...disabled, capabilities: { enabled: true } });
        expect(yield* invoke(broker).pipe(failure)).toMatchObject({ code: "HOST_AMBIGUOUS" });
        const explicit = yield* invoke(broker, hostId);
        expect(yield* Queue.take(disabled.inbox)).toMatchObject({ requestId: explicit.requestId });
        yield* explicit.cancel;
      }),
    ),
);

it.effect("round trips ping and forwards generic kinds, input, context and remote errors", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const host = yield* startHost(broker);
      const ping = yield* broker.ping(hostId).pipe(Effect.forkScoped);
      const request = yield* Queue.take(host.inbox);
      expect(request).toMatchObject({ type: "request", kind: "ping", input: {} });
      yield* broker.respond({
        ...host,
        requestId: request.requestId,
        ok: true,
        result: { pong: true },
      });
      expect(yield* Fiber.join(ping)).toEqual({ pong: true });

      const context = {
        threadId: ThreadId.make("thread-1"),
        provider: "claude",
        label: "future MCP",
      };
      const handle = yield* broker.invoke({
        kind: "future.kind",
        input: [1, "two"],
        context,
        timeoutMs: 500,
      });
      expect(yield* Queue.take(host.inbox)).toEqual({
        type: "request",
        requestId: handle.requestId,
        kind: "future.kind",
        input: [1, "two"],
        context,
        timeoutMs: 500,
      });
      yield* broker.respond({
        ...host,
        requestId: handle.requestId,
        ok: false,
        error: { code: "EACCES", message: "Host denied access" },
      });
      expect(yield* handle.result.pipe(failure)).toMatchObject({
        code: "HOST_ERROR",
        remoteCode: "EACCES",
        message: "Host denied access",
      });
    }),
  ),
);

it.effect("delivers batches in seq order and drains buffered events after the final result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const host = yield* startHost(broker);
      const handle = yield* invoke(broker);
      yield* broker.emit(batch(host, handle.requestId, 0));
      expect(yield* broker.emit(batch(host, handle.requestId, 2)).pipe(failure)).toMatchObject({
        code: "STALE_CONNECTION",
        message: "Expected event seq 1, received 2.",
      });
      const next = {
        ...batch(host, handle.requestId, 1),
        events: [
          { kind: "stderr" as const, data: "err" },
          { kind: "progress" as const, data: "halfway" },
          { kind: "notification" as const, data: "notice" },
        ],
      };
      yield* broker.emit(next);
      yield* broker.respond({ ...host, requestId: handle.requestId, ok: true, result: 42 });
      expect(yield* handle.result).toBe(42);
      expect(yield* Stream.runCollect(handle.events)).toEqual([
        batch(host, handle.requestId, 0),
        next,
      ]);
      yield* broker.emit(batch(host, handle.requestId, 2));
    }),
  ),
);

it.effect("cancels once, sends cancel and frees the host slot", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker.pipe(
        Effect.provideService(DesktopChannelBroker.DesktopChannelBrokerOptions, {
          maxInFlightPerHost: 1,
          eventBufferCapacity: 256,
        }),
      );
      const host = yield* startHost(broker);
      const handle = yield* invoke(broker);
      yield* Queue.take(host.inbox);
      yield* handle.cancel;
      yield* handle.cancel;
      expect(yield* Queue.take(host.inbox)).toEqual({
        type: "cancel",
        requestId: handle.requestId,
      });
      expect(yield* handle.result.pipe(failure)).toMatchObject({ code: "CANCELLED" });
      expect(yield* Stream.runCollect(handle.events)).toEqual([]);
      const next = yield* invoke(broker);
      expect(yield* Queue.take(host.inbox)).toMatchObject({
        type: "request",
        requestId: next.requestId,
      });
      yield* next.cancel;
    }),
  ),
);

it.effect(
  "times out only one request, sends cancel and preserves other requests and the connection",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const host = yield* startHost(broker);
        const timedOut = yield* broker.invoke({ kind: "ping", input: {}, timeoutMs: 1_000 });
        yield* Queue.take(host.inbox);
        const other = yield* invoke(broker);
        yield* Queue.take(host.inbox);
        yield* TestClock.adjust(1_000);
        expect(yield* timedOut.result.pipe(failure)).toMatchObject({ code: "TIMEOUT" });
        expect(yield* Queue.take(host.inbox)).toEqual({
          type: "cancel",
          requestId: timedOut.requestId,
        });
        expect(yield* broker.listHosts()).toHaveLength(1);
        yield* broker.respond({
          ...host,
          requestId: other.requestId,
          ok: true,
          result: "still here",
        });
        expect(yield* other.result).toBe("still here");
        const next = yield* invoke(broker);
        yield* broker.respond({ ...host, requestId: next.requestId, ok: true, result: "reusable" });
        expect(yield* next.result).toBe("reusable");
      }),
    ),
);

it.effect(
  "fails all requests on disconnect, retains capabilities and records authenticated identity",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const host = yield* startHost(broker);
        const capabilities = {
          enabled: true,
          exec: { version: "1", shells: ["pwsh"] },
          future: { v: 2 },
        };
        yield* broker.updateCapabilities({ ...host, capabilities });
        expect(yield* broker.listHosts()).toEqual([
          {
            ...makeHost(),
            capabilities,
            connectionId: host.connectionId,
            connectedAt: 0,
            auth,
          },
        ]);
        const first = yield* invoke(broker);
        const second = yield* invoke(broker);
        yield* Fiber.interrupt(host.consumer);
        for (const handle of [first, second]) {
          expect(yield* handle.result.pipe(failure)).toMatchObject({
            code: "HOST_DISCONNECTED",
          });
          expect(yield* Stream.runCollect(handle.events)).toEqual([]);
        }
        expect(yield* broker.listHosts()).toEqual([]);
        expect(yield* broker.getLastCapabilities(hostId)).toEqual(capabilities);
        expect(yield* broker.getLastCapabilities(secondHostId)).toBeUndefined();
        expect(yield* invoke(broker).pipe(failure)).toMatchObject({ code: "HOST_OFFLINE" });
      }),
    ),
);

it.effect("replaces the old connection and keeps the replacement authoritative", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const old = yield* startHost(broker);
      const handle = yield* invoke(broker);
      const replacement = yield* startHost(broker);
      expect(yield* handle.result.pipe(failure)).toMatchObject({ code: "HOST_REPLACED" });
      expect(Exit.isSuccess(yield* Fiber.await(old.consumer))).toBe(true);
      expect(replacement.connectionId).not.toBe(old.connectionId);
      expect(
        yield* broker
          .respond({ ...old, requestId: handle.requestId, ok: true, result: "old" })
          .pipe(failure),
      ).toMatchObject({ code: "STALE_CONNECTION" });
      const next = yield* invoke(broker);
      expect(yield* Queue.take(replacement.inbox)).toMatchObject({ requestId: next.requestId });
      yield* broker.respond({ ...replacement, requestId: next.requestId, ok: true, result: "new" });
      expect(yield* next.result).toBe("new");
    }),
  ),
);

for (const terminal of ["timeout", "replacement"] as const) {
  it.effect(`discards queued requests after ${terminal} even within a pulled batch`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const broker = yield* makeBroker;
        const connected = yield* Deferred.make<void>();
        const releaseConnected = yield* Deferred.make<void>();
        const receivedFirst = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const receivedCancel = yield* Deferred.make<void>();
        const delivered: string[] = [];
        const consumer = yield* Stream.runForEach(
          yield* broker.connect(makeHost(), auth),
          (message) => {
            if (message.type === "connected")
              return Deferred.succeed(connected, undefined).pipe(
                Effect.andThen(Deferred.await(releaseConnected)),
              );
            if (message.type === "cancel") return Deferred.succeed(receivedCancel, undefined);
            delivered.push(message.requestId);
            return Deferred.succeed(receivedFirst, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
            );
          },
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);
        const first = yield* invoke(broker);
        const second = yield* broker.invoke({ kind: "ping", input: {}, timeoutMs: 1_000 });
        yield* Deferred.succeed(releaseConnected, undefined);
        yield* Deferred.await(receivedFirst);
        if (terminal === "timeout") {
          yield* TestClock.adjust(1_000);
          expect(yield* second.result.pipe(failure)).toMatchObject({ code: "TIMEOUT" });
        } else {
          yield* startHost(broker);
          expect(yield* first.result.pipe(failure)).toMatchObject({ code: "HOST_REPLACED" });
          expect(yield* second.result.pipe(failure)).toMatchObject({ code: "HOST_REPLACED" });
        }
        yield* Deferred.succeed(releaseFirst, undefined);
        if (terminal === "timeout") yield* Deferred.await(receivedCancel);
        else expect(Exit.isSuccess(yield* Fiber.await(consumer))).toBe(true);
        expect(delivered).toEqual([first.requestId]);
      }),
    ),
  );
}

it.effect("rejects wrong host, connection and request identities for responses and batches", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const host = yield* startHost(broker);
      const foreign = yield* startHost(broker, makeHost({ hostId: secondHostId }));
      const handle = yield* invoke(broker, hostId);
      for (const identity of [
        { hostId, connectionId: "wrong", requestId: handle.requestId },
        { ...foreign, requestId: handle.requestId },
        { ...host, requestId: "unknown" },
      ]) {
        expect(
          yield* broker.respond({ ...identity, ok: true, result: "wrong" }).pipe(failure),
        ).toMatchObject({ code: "STALE_CONNECTION" });
        expect(
          yield* broker.emit({ ...batch(host, handle.requestId), ...identity }).pipe(failure),
        ).toMatchObject({ code: "STALE_CONNECTION" });
      }
      expect(
        yield* broker
          .updateCapabilities({ ...host, connectionId: "wrong", capabilities: { enabled: false } })
          .pipe(failure),
      ).toMatchObject({ code: "STALE_CONNECTION" });
      yield* broker.respond({ ...host, requestId: handle.requestId, ok: true, result: "owner" });
      expect(yield* handle.result).toBe("owner");
      expect(
        yield* broker
          .respond({ ...host, requestId: handle.requestId, ok: true, result: "duplicate" })
          .pipe(failure),
      ).toMatchObject({ code: "STALE_CONNECTION" });
    }),
  ),
);

it.effect("backpressures emit after 256 batches and resumes when events are consumed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const host = yield* startHost(broker);
      const handle = yield* invoke(broker);
      for (let seq = 0; seq < 256; seq++) yield* broker.emit(batch(host, handle.requestId, seq));
      const completed = yield* Deferred.make<void>();
      const blocked = yield* broker.emit(batch(host, handle.requestId, 256)).pipe(
        Effect.tap(() => Deferred.succeed(completed, undefined)),
        Effect.forkScoped({ startImmediately: true }),
      );
      expect(yield* Deferred.isDone(completed)).toBe(false);
      const events = yield* Stream.runCollect(handle.events.pipe(Stream.take(257))).pipe(
        Effect.forkScoped,
      );
      yield* Fiber.join(blocked);
      expect((yield* Fiber.join(events)).map((event) => event.seq)).toEqual(
        Array.from({ length: 257 }, (_, seq) => seq),
      );
      yield* broker.respond({ ...host, requestId: handle.requestId, ok: true, result: "done" });
      expect(yield* handle.result).toBe("done");
    }),
  ),
);

it.effect("releases blocked emit when a request ends and drops batches after a consumer ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker.pipe(
        Effect.provideService(DesktopChannelBroker.DesktopChannelBrokerOptions, {
          maxInFlightPerHost: 16,
          eventBufferCapacity: 1,
        }),
      );
      const host = yield* startHost(broker);
      const handle = yield* invoke(broker);
      yield* broker.emit(batch(host, handle.requestId));
      const blocked = yield* broker
        .emit(batch(host, handle.requestId, 1))
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* handle.cancel;
      yield* Fiber.join(blocked);
      yield* broker.emit(batch(host, handle.requestId, 2));

      const next = yield* broker.invoke({ kind: "ping", input: {}, timeoutMs: 1_000 });
      yield* broker.emit(batch(host, next.requestId));
      expect(yield* Stream.runCollect(next.events.pipe(Stream.take(1)))).toHaveLength(1);
      for (let seq = 1; seq <= 5; seq++) yield* broker.emit(batch(host, next.requestId, seq));
      // Ending event consumption must not stop the independent request deadline.
      yield* TestClock.adjust(1_000);
      expect(yield* next.result.pipe(failure)).toMatchObject({ code: "TIMEOUT" });
    }),
  ),
);

it.effect("enforces the default limit of 16 requests independently for each host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      yield* startHost(broker);
      yield* startHost(broker, makeHost({ hostId: secondHostId }));
      const handles = [];
      for (let i = 0; i < 16; i++) handles.push(yield* invoke(broker, hostId));
      expect(yield* invoke(broker, hostId).pipe(failure)).toMatchObject({ code: "HOST_BUSY" });
      const other = yield* invoke(broker, secondHostId);
      yield* other.cancel;
      yield* handles[0]!.cancel;
      const available = yield* invoke(broker, hostId);
      yield* available.cancel;
    }),
  ),
);

it.effect("cancels requests when the caller's scope closes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const host = yield* startHost(broker);
      const handle = yield* Effect.scoped(invoke(broker));
      expect(yield* handle.result.pipe(failure)).toMatchObject({ code: "CANCELLED" });
      expect(yield* Queue.take(host.inbox)).toMatchObject({
        type: "cancel",
        requestId: handle.requestId,
      });
    }),
  ),
);

it.effect("preserves unknown capabilities across schema decoding and encoding", () =>
  Effect.gen(function* () {
    const capabilities = {
      enabled: true,
      future: { version: 3 },
      mcp: {
        version: "1",
        servers: [
          {
            id: "local",
            name: "Local MCP",
            status: "connected",
            tools: [{ name: "read", description: "Read a file", inputSchema: { type: "object" } }],
          },
        ],
      },
    };
    const decoded = yield* decodeCapabilities(capabilities);
    expect(decoded).toEqual(capabilities);
    expect(yield* encodeCapabilities(decoded)).toEqual(capabilities);
  }),
);

it.effect("round trips connect, emit, capabilities and respond through the WS RPC contracts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* makeBroker;
      const group = RpcGroup.make(
        ...Array.from(WsRpcGroup.requests.values()).filter(
          (rpc) =>
            rpc._tag === WS_METHODS.desktopChannelConnect ||
            rpc._tag === WS_METHODS.desktopChannelRespond ||
            rpc._tag === WS_METHODS.desktopChannelEmit ||
            rpc._tag === WS_METHODS.desktopChannelUpdateCapabilities,
        ),
      );
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          group.toLayer({
            [WS_METHODS.desktopChannelConnect]: (host) => Stream.unwrap(broker.connect(host, auth)),
            [WS_METHODS.desktopChannelRespond]: broker.respond,
            [WS_METHODS.desktopChannelEmit]: broker.emit,
            [WS_METHODS.desktopChannelUpdateCapabilities]: broker.updateCapabilities,
          }),
        ),
      );
      const connected = yield* Deferred.make<string>();
      yield* Stream.runForEach(client[WS_METHODS.desktopChannelConnect](makeHost()), (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, event.connectionId);
        if (event.type === "cancel") return Effect.void;
        return Effect.gen(function* () {
          const connectionId = yield* Deferred.await(connected);
          yield* client[WS_METHODS.desktopChannelEmit](
            batch({ hostId, connectionId }, event.requestId),
          );
          yield* client[WS_METHODS.desktopChannelRespond]({
            hostId,
            connectionId,
            requestId: event.requestId,
            ok: true,
            result: { pong: "rpc" },
          });
        });
      }).pipe(Effect.forkScoped);
      const connectionId = yield* Deferred.await(connected);
      yield* client[WS_METHODS.desktopChannelUpdateCapabilities]({
        hostId,
        connectionId,
        capabilities: { enabled: true, future: { version: 2 } },
      });
      expect(yield* broker.ping()).toEqual({ pong: "rpc" });
      expect(yield* broker.getLastCapabilities(hostId)).toEqual({
        enabled: true,
        future: { version: 2 },
      });
      expect(
        yield* client[WS_METHODS.desktopChannelRespond]({
          hostId,
          connectionId: "wrong",
          requestId: "unknown",
          ok: true,
          result: null,
        }).pipe(failure),
      ).toMatchObject({ code: "STALE_CONNECTION" });
    }),
  ),
);
