import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { vi } from "vite-plus/test";

import {
  DesktopAppSettings,
  DEFAULT_DESKTOP_SETTINGS,
  layerTest,
} from "../../settings/DesktopAppSettings.ts";
import {
  createRemoteControlRequestRouter,
  RemoteControlRequestRouter,
} from "../../remoteControl/RemoteControlRequestRouter.ts";
import { RemoteControlStore } from "../../remoteControl/RemoteControlStore.ts";
import { start, setEnvironmentEnabled } from "./remoteControl.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import * as Channels from "../channels.ts";

const sender = vi.hoisted(() => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    id: 1,
    isDestroyed: () => false,
    on: (event: string, callback: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set();
      set.add(callback);
      listeners.set(event, set);
    },
    removeListener: (event: string, callback: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(callback);
    },
    fire: (event: string, ...args: unknown[]) => {
      for (const callback of listeners.get(event) ?? []) callback(...args);
    },
  };
});
vi.mock("electron", () => ({ webContents: { fromId: () => sender } }));

const identity = {
  hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
  hostName: "test",
  platform: "win32" as const,
  appVersion: "1",
};
const input = {
  environmentId: "env",
  connectionId: "c",
  request: { requestId: "r", kind: "wait", input: {}, context: {}, timeoutMs: 1000 },
};

it.effect("rejects requests from disabled environments in the main process", () =>
  Effect.gen(function* () {
    const router = createRemoteControlRequestRouter({
      identity: async () => identity,
      now: () => 0,
    });
    const result = yield* start.handler(input, { sender }).pipe(
      Effect.provide(layerTest()),
      Effect.provideService(RemoteControlRequestRouter, {
        router,
        getHostIdentity: Effect.succeed(identity),
      }),
      Effect.exit,
    );
    expect(Exit.isFailure(result)).toBe(true);
    const next = yield* Effect.promise(() =>
      router.next("r", 1).then(
        () => false,
        () => true,
      ),
    );
    expect(next).toBe(true);
  }),
);

it.effect.each(["destroyed", "render-process-gone", "did-start-navigation"])(
  "aborts renderer requests on %s",
  (event) =>
    Effect.gen(function* () {
      let signal: AbortSignal | undefined;
      const router = createRemoteControlRequestRouter({
        identity: async () => identity,
        now: () => 0,
        handlers: {
          wait: async (context) => {
            signal = context.signal;
            await new Promise<void>((resolve) =>
              context.signal.addEventListener("abort", () => resolve()),
            );
          },
        },
      });
      yield* start.handler(input, { sender }).pipe(
        Effect.provide(
          layerTest({
            ...DEFAULT_DESKTOP_SETTINGS,
            remoteControl: {
              ...DEFAULT_DESKTOP_SETTINGS.remoteControl,
              hostId: identity.hostId,
              enabledEnvironmentIds: ["env"],
            },
          }),
        ),
        Effect.provideService(RemoteControlRequestRouter, {
          router,
          getHostIdentity: Effect.succeed(identity),
        }),
      );
      if (event === "did-start-navigation") {
        sender.fire(event, {}, "https://test", false, false);
        expect(signal?.aborted).toBe(false);
        sender.fire(event, {}, "https://test/#hash", true, true);
        expect(signal?.aborted).toBe(false);
      }
      sender.fire(event, {}, "https://test", false, true);
      expect(signal?.aborted).toBe(true);
      const removed = yield* Effect.promise(() =>
        router.next("r", 1).then(
          () => false,
          () => true,
        ),
      );
      expect(removed).toBe(true);
    }),
);

it.effect("persists switches, broadcasts changes, and aborts requests when disabled", () =>
  Effect.gen(function* () {
    let signal: AbortSignal | undefined;
    const router = createRemoteControlRequestRouter({
      identity: async () => identity,
      now: () => 0,
      handlers: {
        wait: async (context) => {
          signal = context.signal;
          await new Promise<void>((resolve) =>
            context.signal.addEventListener("abort", () => resolve()),
          );
        },
      },
    });
    const store = RemoteControlStore.of({
      authorize: async () => {},
      resolveGrant: async () => {},
      grantState: () => "none",
      listGrants: () => [],
      getPendingGrantRequests: () => [],
      revokeGrant: async () => {},
      rejectEnvironment: vi.fn(),
      appendAudit: async () => {},
      readAudit: async () => [],
    });
    const messages: unknown[][] = [];
    const windows = ElectronWindow.of({
      create: () => Effect.die("unexpected create"),
      main: Effect.succeedNone,
      currentMainOrFirst: Effect.succeedNone,
      focusedMainOrFirst: Effect.succeedNone,
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      prepareReveal: () => Effect.succeed(false),
      reveal: () => Effect.void,
      sendAll: (...args) =>
        Effect.sync(() => {
          messages.push(args);
        }),
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    });
    const settings = yield* DesktopAppSettings;
    yield* setEnvironmentEnabled.handler({ environmentId: "env", enabled: true }).pipe(
      Effect.provideService(RemoteControlRequestRouter, {
        router,
        getHostIdentity: Effect.succeed(identity),
      }),
      Effect.provideService(ElectronWindow, windows),
      Effect.provideService(RemoteControlStore, store),
    );
    expect((yield* settings.get).remoteControl.enabledEnvironmentIds).toEqual(["env"]);
    router.start(input, { id: 1, onGone: () => () => {} });
    yield* setEnvironmentEnabled.handler({ environmentId: "env", enabled: false }).pipe(
      Effect.provideService(RemoteControlRequestRouter, {
        router,
        getHostIdentity: Effect.succeed(identity),
      }),
      Effect.provideService(ElectronWindow, windows),
      Effect.provideService(RemoteControlStore, store),
    );
    expect(signal?.aborted).toBe(true);
    expect(store.rejectEnvironment).toHaveBeenCalledWith("env");
    expect(
      messages.filter(([channel]) => channel === Channels.REMOTE_CONTROL_ENABLED_CHANGED_CHANNEL),
    ).toEqual([
      [Channels.REMOTE_CONTROL_ENABLED_CHANGED_CHANNEL, ["env"]],
      [Channels.REMOTE_CONTROL_ENABLED_CHANGED_CHANNEL, []],
    ]);
    router.dispose();
  }).pipe(Effect.provide(layerTest())),
);
