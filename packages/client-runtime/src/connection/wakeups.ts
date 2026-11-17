import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

export type ConnectionWakeup =
  | "application-active"
  | "application-active-probe"
  | "application-active-reconnect"
  | "credentials-changed";

export function isApplicationActiveWakeup(reason: ConnectionWakeup): boolean {
  return (
    reason === "application-active" ||
    reason === "application-active-probe" ||
    reason === "application-active-reconnect"
  );
}

export function shouldResubscribeAfterWakeup(reason: ConnectionWakeup): boolean {
  return reason === "application-active" || reason === "application-active-probe";
}

export class ConnectionWakeups extends Context.Service<
  ConnectionWakeups,
  {
    readonly changes: Stream.Stream<ConnectionWakeup>;
  }
>()("@t3tools/client-runtime/connection/wakeups/ConnectionWakeups") {}

/** The slice of a DOM window used here; this package is built without DOM types. */
interface WakeupEventTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

const desktopWakeups = Stream.unwrap(
  Effect.sync(() => {
    // React Native also has a window global, but has no DOM event bridge.
    const candidate = (globalThis as { readonly window?: Partial<WakeupEventTarget> }).window;
    if (
      typeof candidate?.addEventListener !== "function" ||
      typeof candidate.removeEventListener !== "function"
    )
      return Stream.empty;
    const target = candidate as WakeupEventTarget;
    return Stream.callback<ConnectionWakeup>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const listener = () => Queue.offerUnsafe(queue, "application-active-probe");
          target.addEventListener("t3:connection-wakeup", listener);
          return () => target.removeEventListener("t3:connection-wakeup", listener);
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    );
  }),
);

const make = (service: ConnectionWakeups["Service"]) =>
  ConnectionWakeups.of({
    changes: Stream.merge(service.changes, desktopWakeups),
  });

export const layer = (service: ConnectionWakeups["Service"]) =>
  Layer.succeed(ConnectionWakeups, make(service));
