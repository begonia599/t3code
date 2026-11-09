import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vite-plus/test";
import { DesktopAppSettings, layerTest } from "../../settings/DesktopAppSettings.ts";
import {
  createRemoteControlStore,
  RemoteControlStore,
} from "../../remoteControl/RemoteControlStore.ts";
import { createWinExecService, WinExecService } from "../../remoteControl/WinExecService.ts";
import {
  createRemoteControlRequestRouter,
  RemoteControlRequestRouter,
} from "../../remoteControl/RemoteControlRequestRouter.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import type { DesktopIpcMethod } from "../DesktopIpc.ts";
import * as Methods from "./remoteControl.ts";
import * as Channels from "../channels.ts";

vi.mock("electron", () => ({ webContents: { fromId: () => undefined } }));

it.effect(
  "exposes config, pending approval, grants, capabilities, audit and disconnect through typed IPC",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-control-ipc-" });
      const messages: Array<{ channel: string; payload: unknown }> = [];
      const publish = (channel: string, payload: unknown) => {
        messages.push({ channel, payload });
      };
      const store = yield* Effect.promise(() =>
        createRemoteControlStore({
          stateDir: dir,
          onPendingChanged: (pending) =>
            publish(Channels.REMOTE_CONTROL_PENDING_CHANGED_CHANNEL, pending),
          onGrantsChanged: (grants) =>
            publish(Channels.REMOTE_CONTROL_GRANTS_CHANGED_CHANNEL, grants),
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => store.rejectEnvironment()));
      const windows = ElectronWindow.of({
        create: () => Effect.die("unexpected create"),
        main: Effect.succeedNone,
        currentMainOrFirst: Effect.succeedNone,
        focusedMainOrFirst: Effect.succeedNone,
        setMain: () => Effect.void,
        clearMain: () => Effect.void,
        prepareReveal: () => Effect.succeed(false),
        reveal: () => Effect.void,
        sendAll: (channel, payload) => Effect.sync(() => publish(channel, payload)),
        destroyAll: Effect.void,
        syncAllAppearance: () => Effect.void,
      });
      const settings = yield* DesktopAppSettings;
      const fixtureConfig = (yield* settings.get).remoteControl;
      const service = createWinExecService({
        platform: "linux",
        store,
        getConfig: async () => fixtureConfig,
      });
      const identity = {
        hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
        hostName: "test",
        platform: "win32" as const,
        appVersion: "1",
      };
      const router = createRemoteControlRequestRouter({
        identity: async () => identity,
        now: () => 0,
        handlers: service.handlers,
      });
      const invoke = (
        method: DesktopIpcMethod<
          Effect.Error<ReturnType<(typeof Methods.methods)[number]["handler"]>>,
          | DesktopAppSettings
          | RemoteControlStore
          | WinExecService
          | ElectronWindow
          | RemoteControlRequestRouter
        >,
        input?: unknown,
      ) =>
        method.handler(input).pipe(
          Effect.provideService(DesktopAppSettings, settings),
          Effect.provideService(RemoteControlStore, store),
          Effect.provideService(WinExecService, service),
          Effect.provideService(ElectronWindow, windows),
          Effect.provideService(RemoteControlRequestRouter, {
            router,
            getHostIdentity: Effect.succeed(identity),
          }),
        );
      expect(yield* invoke(Methods.getConfig)).toMatchObject({
        allowlist: [],
        mappings: [],
        strictMode: false,
      });
      const config = yield* invoke(Methods.updateConfig, {
        allowlist: ["C:/work/"],
        strictMode: true,
      });
      expect(config).toMatchObject({ allowlist: ["C:\\work"], strictMode: true });
      expect(messages.at(-1)).toEqual({
        channel: Channels.REMOTE_CONTROL_CONFIG_CHANGED_CHANNEL,
        payload: config,
      });
      const invalidConfig = yield* invoke(Methods.updateConfig, { allowlist: ["relative"] }).pipe(
        Effect.match({ onSuccess: () => null, onFailure: (error) => error }),
      );
      expect(invalidConfig).toMatchObject({ message: expect.stringContaining("absolute Windows") });
      expect(yield* invoke(Methods.getCapabilities)).toMatchObject({
        enabled: true,
        exec: { version: "1", shells: expect.any(Array) },
      });
      const grantInput = {
        environmentId: "env",
        threadId: "thread",
        provider: "codex",
        label: null,
        mode: "argv" as const,
        summary: "node",
        winCwd: "C:\\work",
        strictMode: false,
      };
      const authorization = store.authorize(
        grantInput,
        new AbortController().signal,
        async () => {},
      );
      const pending = store.getPendingGrantRequests();
      expect(yield* invoke(Methods.getPendingGrantRequests)).toEqual(pending);
      expect(messages.at(-1)?.payload).toEqual(pending);
      const invalidGrant = yield* invoke(Methods.resolveGrant, {
        grantRequestId: "fabricated",
        decision: "allow-session",
      }).pipe(Effect.match({ onSuccess: () => null, onFailure: (error) => error }));
      expect(invalidGrant).toMatchObject({
        message: expect.stringContaining("Unknown or expired"),
      });
      yield* invoke(Methods.resolveGrant, {
        grantRequestId: pending[0]!.grantRequestId,
        decision: "allow-session",
      });
      yield* Effect.promise(() => authorization);
      const grants = yield* invoke(Methods.listGrants);
      expect(grants).toHaveLength(1);
      expect(
        messages.find((m) => m.channel === Channels.REMOTE_CONTROL_GRANTS_CHANGED_CHANNEL)?.payload,
      ).toEqual(grants);
      expect(yield* invoke(Methods.getPendingGrantRequests)).toEqual([]);
      yield* invoke(Methods.revokeGrant, { environmentId: "env", threadId: "thread" });
      expect(yield* invoke(Methods.listGrants)).toEqual([]);
      yield* Effect.promise(() =>
        store.appendAudit({
          requestId: "r",
          startedAt: "2026-01-01T00:00:00.000Z",
          finishedAt: null,
          threadId: "thread",
          provider: "codex",
          label: null,
          mode: "argv",
          summary: "node",
          winCwd: null,
          outcome: "error",
          exitCode: null,
          errorCode: "CWD_NOT_ALLOWED",
          durationMs: 1,
        }),
      );
      expect(yield* invoke(Methods.readAudit, { limit: 20 })).toHaveLength(1);
      yield* invoke(Methods.setEnvironmentEnabled, { environmentId: "env", enabled: true });
      const blocked = store.authorize(grantInput, new AbortController().signal, async () => {});
      const rejected = expect(blocked).rejects.toMatchObject({ code: "GRANT_DENIED" });
      yield* invoke(Methods.disconnectAll);
      yield* Effect.promise(() => rejected);
      expect(yield* invoke(Methods.getEnabledEnvironmentIds)).toEqual([]);
      expect(yield* invoke(Methods.getPendingGrantRequests)).toEqual([]);
      expect(messages.at(-1)).toMatchObject({
        channel: Channels.REMOTE_CONTROL_CONFIG_CHANGED_CHANNEL,
        payload: { enabledEnvironmentIds: [] },
      });
    }).pipe(Effect.provide(Layer.mergeAll(layerTest(), NodeServices.layer)), Effect.scoped),
);
