import {
  RemoteControlEnvironmentEnabled,
  RemoteControlHostIdentity,
  RemoteControlNext,
  RemoteControlRequestId,
  RemoteControlStart,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { webContents } from "electron";

import { RemoteControlRequestRouter } from "../../remoteControl/RemoteControlRequestRouter.ts";
import { DesktopAppSettings } from "../../settings/DesktopAppSettings.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import * as Channels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

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
    if (!enabled) router.cancelEnvironment(environmentId);
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
export const methods = [
  getHostIdentity,
  getEnabledEnvironmentIds,
  setEnvironmentEnabled,
  start,
  next,
  cancel,
] as const;
