import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { createDesktopChannelHostLoop } from "../../../../packages/client-runtime/src/state/desktopChannel.ts";
import {
  AuthSessionId,
  EnvironmentId,
  WS_METHODS,
  WsRpcGroup,
  type RemoteControlNext,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcTest from "effect/unstable/rpc/RpcTest";

import { DesktopChannelBroker, layer } from "./DesktopChannelBroker.ts";

it.effect("invokes ping through the real broker, WS RPC contracts and desktop host loop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* DesktopChannelBroker.pipe(
        Effect.provide(layer.pipe(Layer.provide(NodeServices.layer))),
      );
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
            [WS_METHODS.desktopChannelConnect]: (host) =>
              Stream.unwrap(
                broker.connect(host, {
                  subject: "owner",
                  sessionId: AuthSessionId.make("desktop-test"),
                }),
              ),
            [WS_METHODS.desktopChannelRespond]: broker.respond,
            [WS_METHODS.desktopChannelEmit]: broker.emit,
            [WS_METHODS.desktopChannelUpdateCapabilities]: broker.updateCapabilities,
          }),
        ),
      );
      const identity = {
        hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
        hostName: "Windows",
        platform: "win32" as const,
        appVersion: "1",
      };
      const results = new Map<string, RemoteControlNext>();
      const context = yield* Effect.context<never>();
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Adapt the Promise-based host RPC dependency to this test's Effect context.
      const run = Effect.runPromiseWith(context);
      const loop = createDesktopChannelHostLoop({
        host: {
          ...identity,
          environmentId: EnvironmentId.make("env"),
          capabilities: { enabled: true },
        },
        bridge: {
          start: async ({ request }) => {
            results.set(request.requestId, {
              type: "result",
              ok: true,
              result: { ...identity, now: 123 },
            });
          },
          next: async ({ requestId }) => {
            const result = results.get(requestId)!;
            results.delete(requestId);
            return result;
          },
          cancel: async ({ requestId }) => {
            results.delete(requestId);
          },
        },
        rpc: {
          emit: (input) => run(client[WS_METHODS.desktopChannelEmit](input)),
          respond: (input) => run(client[WS_METHODS.desktopChannelRespond](input)),
        },
        clock: { now: () => 123 },
        onError: (error) => {
          throw error;
        },
      });
      yield* Effect.addFinalizer(() => Effect.sync(loop.disconnect));
      const connected = yield* Deferred.make<void>();
      yield* client[WS_METHODS.desktopChannelConnect]({
        ...identity,
        environmentId: EnvironmentId.make("env"),
        capabilities: { enabled: true },
      }).pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => loop.receive(event));
            if (event.type === "connected") yield* Deferred.succeed(connected, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(connected);
      const handle = yield* broker.invoke({ kind: "ping", input: {}, timeoutMs: 1000 });
      expect(yield* handle.result).toEqual({ ...identity, now: 123 });
    }),
  ),
);
