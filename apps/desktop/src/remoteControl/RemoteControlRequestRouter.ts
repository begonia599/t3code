import type {
  DesktopChannelEmit,
  DesktopChannelRequest,
  RemoteControlHostIdentity,
  RemoteControlNext,
  RemoteControlStart,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Clock from "effect/Clock";
import * as NodeOS from "node:os";

import { DesktopAppSettings } from "../settings/DesktopAppSettings.ts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";

type Events = DesktopChannelEmit["events"];
export interface RequestOwner {
  readonly id: number;
  readonly onGone: (cancel: () => void) => () => void;
}
export type RequestHandler = (input: {
  readonly request: DesktopChannelRequest;
  readonly signal: AbortSignal;
  readonly emit: (event: Events[number]) => Promise<void>;
}) => Promise<unknown>;

const errorResult = (code: string, message = code): RemoteControlNext => ({
  type: "result",
  ok: false,
  error: { code, message },
});

export function createRemoteControlRequestRouter(options: {
  readonly identity: () => Promise<RemoteControlHostIdentity>;
  readonly now: () => number;
  readonly handlers?: Readonly<Record<string, RequestHandler>>;
  readonly capacity?: number;
}) {
  const requests = new Map<
    string,
    {
      ownerId: number;
      environmentId: string;
      controller: AbortController;
      events: Events[];
      result: RemoteControlNext | undefined;
      wake: Set<() => void>;
      pulling: boolean;
    }
  >();
  const owners = new Map<number, () => void>();
  const capacity = options.capacity ?? 64;
  if (capacity < 1) throw new Error("Remote control buffer capacity must be positive");
  const remove = (requestId: string) => {
    const state = requests.get(requestId);
    requests.delete(requestId);
    if (state && ![...requests.values()].some((r) => r.ownerId === state.ownerId)) {
      owners.get(state.ownerId)?.();
      owners.delete(state.ownerId);
    }
  };
  const notify = (state: { wake: Set<() => void> }) => {
    for (const wake of state.wake) wake();
    state.wake.clear();
  };
  const cancel = (requestId: string, ownerId?: number) => {
    const state = requests.get(requestId);
    if (!state || (ownerId !== undefined && state.ownerId !== ownerId)) return;
    state.controller.abort();
    state.events.length = 0;
    state.result = errorResult("CANCELLED");
    notify(state);
  };
  return {
    start(input: RemoteControlStart, owner: RequestOwner) {
      const requestId = input.request.requestId;
      if (requests.has(requestId)) throw new Error("Duplicate remote control request");
      const state = {
        ownerId: owner.id,
        environmentId: input.environmentId,
        controller: new AbortController(),
        events: [] as Events[],
        result: undefined as RemoteControlNext | undefined,
        wake: new Set<() => void>(),
        pulling: false,
      };
      requests.set(requestId, state);
      if (!owners.has(owner.id)) {
        owners.set(
          owner.id,
          owner.onGone(() => {
            for (const [id, request] of requests) {
              if (request.ownerId !== owner.id) continue;
              cancel(id);
              remove(id);
            }
          }),
        );
      }
      const handler: RequestHandler =
        (options.handlers && Object.hasOwn(options.handlers, input.request.kind)
          ? options.handlers[input.request.kind]
          : undefined) ??
        (async () => {
          if (input.request.kind !== "ping") throw { code: "UNSUPPORTED_KIND" };
          return { ...(await options.identity()), now: options.now() };
        });
      void (async () => {
        try {
          const result = await handler({
            request: input.request,
            signal: state.controller.signal,
            emit: async (event) => {
              while (!state.controller.signal.aborted && state.events.length >= capacity) {
                await new Promise<void>((resolve) => state.wake.add(resolve));
              }
              if (state.controller.signal.aborted) throw { code: "CANCELLED" };
              state.events.push([event]);
              notify(state);
            },
          });
          if (!state.controller.signal.aborted) state.result = { type: "result", ok: true, result };
        } catch (error) {
          if (!state.controller.signal.aborted) {
            state.result = errorResult(
              typeof error === "object" &&
                error !== null &&
                "code" in error &&
                typeof error.code === "string"
                ? error.code
                : "HOST_ERROR",
              error instanceof Error ? error.message : "Remote control request failed",
            );
          }
        } finally {
          notify(state);
        }
      })();
    },
    async next(requestId: string, ownerId: number): Promise<RemoteControlNext> {
      const state = requests.get(requestId);
      if (!state || state.ownerId !== ownerId) throw new Error("Unknown remote control request");
      if (state.pulling) throw new Error("Only one next call is allowed per request");
      state.pulling = true;
      try {
        while (state.events.length === 0 && !state.result) {
          await new Promise<void>((resolve) => state.wake.add(resolve));
        }
        const events = state.events.shift();
        if (events) {
          notify(state);
          return { type: "events", events };
        }
        remove(requestId);
        return state.result!;
      } finally {
        state.pulling = false;
      }
    },
    cancel,
    cancelEnvironment(environmentId: string) {
      for (const [id, state] of requests) if (state.environmentId === environmentId) cancel(id);
    },
    dispose() {
      for (const id of requests.keys()) {
        cancel(id);
        remove(id);
      }
    },
  };
}

export class RemoteControlRequestRouter extends Context.Service<
  RemoteControlRequestRouter,
  {
    readonly router: ReturnType<typeof createRemoteControlRequestRouter>;
    readonly getHostIdentity: Effect.Effect<RemoteControlHostIdentity>;
  }
>()("@t3tools/desktop/remoteControl/RemoteControlRequestRouter") {}

export const layer = Layer.effect(
  RemoteControlRequestRouter,
  Effect.gen(function* () {
    const settings = yield* DesktopAppSettings;
    const environment = yield* DesktopEnvironment;
    const clock = yield* Clock.Clock;
    const getHostIdentity = Effect.gen(function* () {
      const platform = environment.platform;
      if (platform !== "win32" && platform !== "linux" && platform !== "darwin") {
        return yield* Effect.die(new Error("Unsupported desktop platform"));
      }
      return {
        hostId: (yield* settings.get).remoteControl.hostId,
        hostName: NodeOS.hostname(),
        platform,
        appVersion: environment.appVersion,
      };
    });
    const runIdentity = yield* Effect.context<never>();
    const router = createRemoteControlRequestRouter({
      identity: () => Effect.runPromiseWith(runIdentity)(getHostIdentity),
      now: () => clock.currentTimeMillisUnsafe(),
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => router.dispose()));
    return { router, getHostIdentity };
  }),
);
