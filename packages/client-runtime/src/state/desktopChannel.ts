import {
  WS_METHODS,
  type DesktopChannelEmit,
  type DesktopChannelCapabilities,
  type DesktopChannelUpdateCapabilities,
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
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, followStreamInEnvironment } from "./runtime.ts";

export interface DesktopChannelHostDependencies {
  readonly host: DesktopChannelHost;
  readonly bridge: Pick<RemoteControlBridge, "start" | "next" | "cancel"> &
    Partial<Pick<RemoteControlBridge, "getCapabilities" | "onCapabilitiesChanged">>;
  readonly rpc: {
    readonly emit: (input: DesktopChannelEmit) => Promise<unknown>;
    readonly updateCapabilities?: (input: DesktopChannelUpdateCapabilities) => Promise<unknown>;
    readonly respond: (input: DesktopChannelResponse) => Promise<unknown>;
  };
  readonly clock: { readonly now: () => number };
  readonly onError: (error: unknown) => void;
  readonly onConnectionChange?: (connected: boolean) => void;
}

export function createDesktopChannelHostLoop(options: DesktopChannelHostDependencies) {
  let connectionId: string | null = null;
  let capabilityRevision = 0;
  let capabilityDelivery = Promise.resolve();
  const pushCapabilities = (capabilities: DesktopChannelCapabilities) => {
    const id = connectionId;
    if (!id || !options.rpc.updateCapabilities) return;
    capabilityDelivery = capabilityDelivery.then(async () => {
      if (connectionId !== id) return;
      try {
        await options.rpc.updateCapabilities!({
          hostId: options.host.hostId,
          connectionId: id,
          capabilities,
        });
      } catch (cause) {
        if (connectionId === id) options.onError(cause);
      }
    });
  };
  const unsubscribe = options.bridge.onCapabilitiesChanged?.((capabilities) => {
    capabilityRevision++;
    pushCapabilities(capabilities);
  });
  let lastConnectionState: boolean | undefined;
  const reportConnection = (connected: boolean) => {
    if (lastConnectionState === connected) return;
    lastConnectionState = connected;
    options.onConnectionChange?.(connected);
  };
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
    reportConnection(false);
  };
  const receive = async (event: DesktopChannelStreamEvent): Promise<void> => {
    if (event.type === "connected") {
      if (connectionId !== null && connectionId !== event.connectionId) disconnect();
      connectionId = event.connectionId;
      reportConnection(true);
      const revision = capabilityRevision;
      const id = connectionId;
      if (options.bridge.getCapabilities) {
        const capabilities = await options.bridge.getCapabilities();
        if (connectionId === id && revision === capabilityRevision) pushCapabilities(capabilities);
      }
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
  return {
    receive,
    disconnect,
    dispose: () => {
      unsubscribe?.();
      disconnect();
    },
  };
}

/**
 * The desktop's DesktopChannel connect stream for one environment. `null` marks a
 * lost connection: no session yet, the stream ended, or it failed.
 */
export function desktopChannelEvents(
  host: DesktopChannelHost,
  getCapabilities?: () => Promise<DesktopChannelCapabilities>,
): Stream.Stream<DesktopChannelStreamEvent | null, never, EnvironmentSupervisor> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor;
      return SubscriptionRef.changes(supervisor.session).pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.succeed(null),
            onSome: (session) =>
              Stream.unwrap(
                Effect.promise(async () => ({
                  ...host,
                  capabilities: getCapabilities ? await getCapabilities() : host.capabilities,
                })).pipe(
                  Effect.map((latestHost) =>
                    session.client[WS_METHODS.desktopChannelConnect](latestHost),
                  ),
                ),
              ).pipe(
                Stream.concat(Stream.succeed(null)),
                Stream.catchCause((cause) =>
                  Stream.fromEffect(Effect.logWarning("Desktop channel disconnected", cause)).pipe(
                    Stream.map(() => null),
                  ),
                ),
              ),
          }),
        ),
      );
    }),
  );
}

/**
 * Feeds every connect-stream event to a fresh host loop, in order.
 *
 * The events are commands, not state: a stream atom only exposes the latest
 * element of each pulled chunk (and marks live values as waiting), so routing
 * them through an atom value drops requests. Consume the stream directly.
 */
export function runDesktopChannelHost<E, R>(
  events: Stream.Stream<DesktopChannelStreamEvent | null, E, R>,
  options: DesktopChannelHostDependencies,
): Effect.Effect<void, E, R> {
  return Effect.suspend(() => {
    const loop = createDesktopChannelHostLoop(options);
    return events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event === null) loop.disconnect();
          else void loop.receive(event).catch(options.onError);
        }),
      ),
      Effect.ensuring(Effect.sync(() => loop.dispose())),
    );
  });
}

export function createDesktopChannelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Mounting the returned atom serves the host until it is unmounted. */
    host: (options: DesktopChannelHostDependencies) =>
      runtime
        .atom(
          runDesktopChannelHost(
            followStreamInEnvironment(
              options.host.environmentId,
              desktopChannelEvents(options.host, options.bridge.getCapabilities),
            ),
            options,
          ),
        )
        .pipe(Atom.setIdleTTL(0)),
    emit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:desktop-channel:emit",
      tag: WS_METHODS.desktopChannelEmit,
    }),
    updateCapabilities: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:desktop-channel:update-capabilities",
      tag: WS_METHODS.desktopChannelUpdateCapabilities,
    }),
    respond: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:desktop-channel:respond",
      tag: WS_METHODS.desktopChannelRespond,
    }),
  };
}
