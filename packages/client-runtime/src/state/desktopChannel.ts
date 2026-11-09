import {
  WS_METHODS,
  type DesktopChannelEmit,
  type DesktopChannelHost,
  type DesktopChannelResponse,
  type DesktopChannelStreamEvent,
  type RemoteControlBridge,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentSubscriptionAtomFamily } from "./runtime.ts";

export interface DesktopChannelHostDependencies {
  readonly host: DesktopChannelHost;
  readonly bridge: Pick<RemoteControlBridge, "start" | "next" | "cancel">;
  readonly rpc: {
    readonly emit: (input: DesktopChannelEmit) => Promise<unknown>;
    readonly respond: (input: DesktopChannelResponse) => Promise<unknown>;
  };
  readonly clock: { readonly now: () => number };
  readonly onError: (error: unknown) => void;
}

export function createDesktopChannelHostLoop(options: DesktopChannelHostDependencies) {
  let connectionId: string | null = null;
  const active = new Map<
    string,
    { connectionId: string; started: Promise<void>; cancelled: boolean }
  >();
  const cancel = (requestId: string) => options.bridge.cancel({ requestId }).catch(options.onError);
  const disconnect = () => {
    connectionId = null;
    for (const [id, state] of active) {
      state.cancelled = true;
      // start may still be crossing IPC; cancel both now and after it settles.
      void cancel(id);
      void state.started.then(
        async () => {
          await cancel(id);
          // Release the local terminal result when no pull is already consuming it.
          await options.bridge.next({ requestId: id }).catch(() => {});
        },
        () => {},
      );
    }
    active.clear();
  };
  const receive = async (event: DesktopChannelStreamEvent): Promise<void> => {
    if (event.type === "connected") {
      if (connectionId !== event.connectionId) disconnect();
      connectionId = event.connectionId;
      return;
    }
    if (event.type === "cancel") {
      const state = active.get(event.requestId);
      await cancel(event.requestId);
      if (state) {
        await state.started.then(
          () => cancel(event.requestId),
          () => {},
        );
      }
      return;
    }
    if (!connectionId || active.has(event.requestId)) return;
    const id = connectionId;
    const state = { connectionId: id, started: Promise.resolve(), cancelled: false };
    active.set(event.requestId, state);
    const current = () =>
      !state.cancelled && connectionId === id && active.get(event.requestId) === state;
    const address = { hostId: options.host.hostId, connectionId: id, requestId: event.requestId };
    const deadline = options.clock.now() + event.timeoutMs;
    let seq = 0;
    try {
      state.started = options.bridge.start({
        environmentId: options.host.environmentId,
        connectionId: id,
        request: event,
      });
      await state.started;
      while (current()) {
        if (options.clock.now() >= deadline) await cancel(event.requestId);
        const batch = await options.bridge.next({ requestId: event.requestId });
        if (!current()) return;
        if (batch.type === "events") {
          await options.rpc.emit({ ...address, seq: seq++, events: batch.events });
        } else {
          await options.rpc.respond(
            batch.ok
              ? { ...address, ok: true, result: batch.result }
              : { ...address, ok: false, error: batch.error },
          );
          return;
        }
      }
    } catch (error) {
      if (!current()) return;
      if (
        !(
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "STALE_CONNECTION"
        )
      ) {
        options.onError(error);
      }
      // A failed emit must never be followed by a success response.
      await cancel(event.requestId);
      await options.bridge.next({ requestId: event.requestId }).catch(() => {});
    } finally {
      if (active.get(event.requestId) === state) active.delete(event.requestId);
    }
  };
  return { receive, disconnect };
}

export function createDesktopChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    connect: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:desktop-channel:connect",
      subscribe: (host: DesktopChannelHost) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const supervisor = yield* EnvironmentSupervisor;
            return SubscriptionRef.changes(supervisor.session).pipe(
              Stream.switchMap(
                Option.match({
                  onNone: () => Stream.succeed(null),
                  onSome: (session) =>
                    session.client[WS_METHODS.desktopChannelConnect](host).pipe(
                      Stream.concat(Stream.succeed(null)),
                      Stream.catchCause((cause) =>
                        Stream.fromEffect(
                          Effect.logWarning("Desktop channel disconnected", cause),
                        ).pipe(Stream.map(() => null)),
                      ),
                    ),
                }),
              ),
            );
          }),
        ),
      idleTtlMs: 0,
    }),
    emit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:desktop-channel:emit",
      tag: WS_METHODS.desktopChannelEmit,
    }),
    respond: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:desktop-channel:respond",
      tag: WS_METHODS.desktopChannelRespond,
    }),
  };
}

export function createDesktopChannelHostAtom<E>(
  requests: Atom.Atom<AsyncResult.AsyncResult<DesktopChannelStreamEvent | null, E>>,
  options: DesktopChannelHostDependencies,
) {
  return Atom.make((get) => {
    const loop = createDesktopChannelHostLoop(options);
    let disposed = false;
    get.addFinalizer(() => {
      disposed = true;
      loop.disconnect();
    });
    const consume = (result: AsyncResult.AsyncResult<DesktopChannelStreamEvent | null, E>) => {
      if (AsyncResult.isSuccess(result) && !result.waiting && result.value !== null) {
        void loop.receive(result.value).catch(options.onError);
      } else {
        loop.disconnect();
      }
    };
    const initial = get.once(requests);
    // Establish cached connection identity before a synchronous request notification.
    if (AsyncResult.isSuccess(initial) && initial.value?.type === "connected") consume(initial);
    get.subscribe(requests, (result) => {
      if (!disposed) consume(result);
    });
  }).pipe(Atom.setIdleTTL(0));
}
