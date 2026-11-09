import {
  DesktopChannelCapabilities,
  DesktopExecLogInput,
  DesktopExecLogEntry,
  RemoteControlConfig,
  RemoteControlConfigPatch,
  RemoteControlGrant,
  RemoteControlGrantKey,
  RemoteControlGrantRequest,
  RemoteControlGrantDecision,
  RemoteControlEnvironmentEnabled,
  RemoteControlHostIdentity,
  RemoteControlNext,
  RemoteControlRequestId,
  RemoteControlStart,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { webContents } from "electron";

import * as NodeOS from "node:os";
import { WinExecService } from "../../remoteControl/WinExecService.ts";
import { RemoteControlStore } from "../../remoteControl/RemoteControlStore.ts";

import { RemoteControlRequestRouter } from "../../remoteControl/RemoteControlRequestRouter.ts";
import { DesktopAppSettings } from "../../settings/DesktopAppSettings.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import * as Channels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

class RemoteControlIpcError extends Schema.TaggedError<RemoteControlIpcError>()(
  "RemoteControlIpcError",
  { message: Schema.String },
) {}
const nativeCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new RemoteControlIpcError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export const getHostIdentity = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_IDENTITY_CHANNEL,
  payload: Schema.Void,
  result: RemoteControlHostIdentity,
  handler: Effect.fn(function* () {
    return yield* (yield* RemoteControlRequestRouter).getHostIdentity;
  }),
});
export const getEnabledEnvironmentIds = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_GET_ENABLED_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(Schema.String),
  handler: Effect.fn(function* () {
    return (yield* (yield* DesktopAppSettings).get).remoteControl.enabledEnvironmentIds;
  }),
});
export const setEnvironmentEnabled = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_SET_ENABLED_CHANNEL,
  payload: RemoteControlEnvironmentEnabled,
  result: Schema.Void,
  handler: Effect.fn(function* ({ environmentId, enabled }) {
    const settings = yield* DesktopAppSettings;
    const { router } = yield* RemoteControlRequestRouter;
    const windows = yield* ElectronWindow;
    const change = yield* settings.setEnvironmentEnabled(environmentId, enabled);
    if (!enabled) {
      (yield* RemoteControlStore).rejectEnvironment(environmentId);
      router.cancelEnvironment(environmentId);
    }
    if (change.changed)
      yield* windows.sendAll(Channels.REMOTE_CONTROL_CONFIG_CHANGED_CHANNEL, {
        ...change.settings.remoteControl,
        hostName: NodeOS.hostname(),
      });
    if (change.changed)
      yield* windows.sendAll(
        Channels.REMOTE_CONTROL_ENABLED_CHANGED_CHANNEL,
        change.settings.remoteControl.enabledEnvironmentIds,
      );
  }),
});
export const start = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_START_CHANNEL,
  payload: RemoteControlStart,
  result: Schema.Void,
  handler: Effect.fn(function* (input, event) {
    const settings = yield* DesktopAppSettings;
    const { router } = yield* RemoteControlRequestRouter;
    if (!(yield* settings.get).remoteControl.enabledEnvironmentIds.includes(input.environmentId)) {
      return yield* Effect.die(new Error("Remote control is disabled for this environment"));
    }
    const sender = event && webContents.fromId(event.sender.id);
    if (!sender || sender.isDestroyed())
      return yield* Effect.die(new Error("Renderer is unavailable"));
    router.start(input, {
      id: sender.id,
      onGone: (cancel) => {
        const navigate = (
          _event: unknown,
          _url: string,
          isInPlace: boolean,
          isMainFrame: boolean,
        ) => {
          if (isMainFrame && !isInPlace) cancel();
        };
        sender.on("destroyed", cancel);
        sender.on("render-process-gone", cancel);
        sender.on("did-start-navigation", navigate);
        return () => {
          sender.removeListener("destroyed", cancel);
          sender.removeListener("render-process-gone", cancel);
          sender.removeListener("did-start-navigation", navigate);
        };
      },
    });
  }),
});
export const next = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_NEXT_CHANNEL,
  payload: RemoteControlRequestId,
  result: RemoteControlNext,
  handler: Effect.fn(function* ({ requestId }, event) {
    const { router } = yield* RemoteControlRequestRouter;
    if (!event) return yield* Effect.die(new Error("Renderer is unavailable"));
    return yield* Effect.promise(() => router.next(requestId, event.sender.id));
  }),
});
export const cancel = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_CANCEL_CHANNEL,
  payload: RemoteControlRequestId,
  result: Schema.Void,
  handler: Effect.fn(function* ({ requestId }, event) {
    const { router } = yield* RemoteControlRequestRouter;
    if (!event) return yield* Effect.die(new Error("Renderer is unavailable"));
    router.cancel(requestId, event.sender.id);
  }),
});

const readConfig = Effect.gen(function* () {
  return { ...(yield* (yield* DesktopAppSettings).get).remoteControl, hostName: NodeOS.hostname() };
});
export const getCapabilities = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_CAPABILITIES_CHANNEL,
  payload: Schema.Void,
  result: DesktopChannelCapabilities,
  handler: Effect.fn(function* () {
    const service = yield* WinExecService;
    return yield* nativeCall(() => service.getCapabilities());
  }),
});
export const getConfig = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_GET_CONFIG_CHANNEL,
  payload: Schema.Void,
  result: RemoteControlConfig,
  handler: Effect.fn(function* () {
    return yield* readConfig;
  }),
});
export const updateConfig = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_UPDATE_CONFIG_CHANNEL,
  payload: RemoteControlConfigPatch,
  result: RemoteControlConfig,
  handler: Effect.fn(function* (patch) {
    const settings = yield* DesktopAppSettings;
    const change = yield* settings.updateRemoteControlConfig(patch);
    const config = { ...change.settings.remoteControl, hostName: NodeOS.hostname() };
    if (change.changed)
      yield* (yield* ElectronWindow).sendAll(
        Channels.REMOTE_CONTROL_CONFIG_CHANGED_CHANNEL,
        config,
      );
    return config;
  }),
});
export const listGrants = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_LIST_GRANTS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(RemoteControlGrant),
  handler: Effect.fn(function* () {
    return (yield* RemoteControlStore).listGrants();
  }),
});
export const revokeGrant = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_REVOKE_GRANT_CHANNEL,
  payload: RemoteControlGrantKey,
  result: Schema.Void,
  handler: Effect.fn(function* (input) {
    const store = yield* RemoteControlStore;
    yield* nativeCall(() => store.revokeGrant(input));
  }),
});
export const getPendingGrantRequests = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_GET_PENDING_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(RemoteControlGrantRequest),
  handler: Effect.fn(function* () {
    return (yield* RemoteControlStore).getPendingGrantRequests();
  }),
});
export const resolveGrant = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_RESOLVE_GRANT_CHANNEL,
  payload: RemoteControlGrantDecision,
  result: Schema.Void,
  handler: Effect.fn(function* (input) {
    const store = yield* RemoteControlStore;
    yield* nativeCall(() => store.resolveGrant(input));
  }),
});
export const readAudit = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_READ_AUDIT_CHANNEL,
  payload: DesktopExecLogInput,
  result: Schema.Array(DesktopExecLogEntry),
  handler: Effect.fn(function* (input) {
    const store = yield* RemoteControlStore;
    return yield* nativeCall(() => store.readAudit(input));
  }),
});
export const disconnectAll = makeIpcMethod({
  channel: Channels.REMOTE_CONTROL_DISCONNECT_ALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn(function* () {
    const settings = yield* DesktopAppSettings;
    const { router } = yield* RemoteControlRequestRouter;
    const service = yield* WinExecService;
    const ids = (yield* settings.get).remoteControl.enabledEnvironmentIds;
    (yield* RemoteControlStore).rejectEnvironment();
    for (const id of ids) router.cancelEnvironment(id);
    yield* Effect.gen(function* () {
      for (const id of ids) yield* settings.setEnvironmentEnabled(id, false);
    }).pipe(Effect.ensuring(Effect.promise(() => service.disconnectAll())));
    const windows = yield* ElectronWindow;
    yield* windows.sendAll(Channels.REMOTE_CONTROL_ENABLED_CHANGED_CHANNEL, []);
    yield* windows.sendAll(Channels.REMOTE_CONTROL_CONFIG_CHANGED_CHANNEL, yield* readConfig);
  }),
});
export const methods = [
  getCapabilities,
  getConfig,
  updateConfig,
  listGrants,
  revokeGrant,
  getPendingGrantRequests,
  resolveGrant,
  readAudit,
  disconnectAll,
  getHostIdentity,
  getEnabledEnvironmentIds,
  setEnvironmentEnabled,
  start,
  next,
  cancel,
] as const;
