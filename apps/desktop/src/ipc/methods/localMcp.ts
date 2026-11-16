// @effect-diagnostics globalDate:off -- Native discovery stamps the local scan time.
// @effect-diagnostics nodeBuiltinImport:off -- Read-only local app configuration discovery.
import {
  LocalMcpAddProposal,
  LocalMcpAddDecision,
  LocalMcpDiscoveryResult,
  LocalMcpServerConfig,
  LocalMcpServerView,
  LocalMcpProbeResult,
  LocalMcpServerIdInput,
  LocalMcpSetEnabledInput,
} from "@t3tools/contracts";
import { discoverNativeLocalMcpServers } from "../../remoteControl/LocalMcpNativeDiscovery.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RemoteControlRequestRouter } from "../../remoteControl/RemoteControlRequestRouter.ts";
import { LocalMcpManager } from "../../remoteControl/LocalMcpManager.ts";
import { WinExecService } from "../../remoteControl/WinExecService.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";
import * as Channels from "../channels.ts";

class LocalMcpIpcError extends Schema.TaggedError<LocalMcpIpcError>()("LocalMcpIpcError", {
  message: Schema.String,
}) {}
const nativeCall = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new LocalMcpIpcError({ message: cause instanceof Error ? cause.message : String(cause) }),
  });
export const list = makeIpcMethod({
  channel: Channels.LOCAL_MCP_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(LocalMcpServerView),
  handler: Effect.fn(function* () {
    return (yield* LocalMcpManager).views();
  }),
});
export const upsert = makeIpcMethod({
  channel: Channels.LOCAL_MCP_UPSERT_CHANNEL,
  payload: LocalMcpServerConfig,
  result: Schema.Array(LocalMcpServerView),
  handler: Effect.fn(function* (config) {
    const manager = yield* LocalMcpManager;
    return yield* nativeCall(() => manager.upsert(config));
  }),
});
export const remove = makeIpcMethod({
  channel: Channels.LOCAL_MCP_REMOVE_CHANNEL,
  payload: LocalMcpServerIdInput,
  result: Schema.Array(LocalMcpServerView),
  handler: Effect.fn(function* ({ id }) {
    const manager = yield* LocalMcpManager;
    return yield* nativeCall(() => manager.remove(id));
  }),
});
export const setEnabled = makeIpcMethod({
  channel: Channels.LOCAL_MCP_SET_ENABLED_CHANNEL,
  payload: LocalMcpSetEnabledInput,
  result: Schema.Array(LocalMcpServerView),
  handler: Effect.fn(function* ({ id, enabled }) {
    const manager = yield* LocalMcpManager;
    return yield* nativeCall(() => manager.setEnabled(id, enabled));
  }),
});
export const restart = makeIpcMethod({
  channel: Channels.LOCAL_MCP_RESTART_CHANNEL,
  payload: LocalMcpServerIdInput,
  result: Schema.Array(LocalMcpServerView),
  handler: Effect.fn(function* ({ id }) {
    const manager = yield* LocalMcpManager;
    return yield* nativeCall(() => manager.restart(id));
  }),
});
export const probe = makeIpcMethod({
  channel: Channels.LOCAL_MCP_PROBE_CHANNEL,
  payload: LocalMcpServerConfig,
  result: LocalMcpProbeResult,
  handler: Effect.fn(function* (config) {
    const manager = yield* LocalMcpManager;
    return yield* nativeCall(() => manager.probe(config));
  }),
});

export const discover = makeIpcMethod({
  channel: Channels.LOCAL_MCP_DISCOVER_CHANNEL,
  payload: Schema.Void,
  result: LocalMcpDiscoveryResult,
  handler: Effect.fn(function* () {
    const manager = yield* LocalMcpManager;
    return yield* nativeCall(() =>
      discoverNativeLocalMcpServers(manager.views().map((view) => view.config)),
    );
  }),
});

export const installEventForwarding = Effect.fn(function* () {
  const manager = yield* LocalMcpManager;
  const exec = yield* WinExecService;
  const windows = yield* ElectronWindow;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  // Serialize deliveries: a slow shell probe cannot reorder old and new catalogs.
  let delivery = Promise.resolve();
  let disposed = false;
  let lastCapabilities = "";
  const unsubscribe = manager.onChanged((views) => {
    const mcp = manager.capabilities();
    delivery = delivery
      .then(async () => {
        if (disposed) return;
        await run(windows.sendAll(Channels.LOCAL_MCP_CHANGED_CHANNEL, views));
        const capabilities = { ...(await exec.getCapabilities()), mcp };
        const serialized = JSON.stringify(capabilities);
        if (serialized === lastCapabilities || disposed) return;
        await run(
          windows.sendAll(Channels.REMOTE_CONTROL_CAPABILITIES_CHANGED_CHANNEL, capabilities),
        );
        lastCapabilities = serialized;
      })
      .catch((cause) => run(Effect.logWarning("MCP IPC forwarding failed", cause)));
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      disposed = true;
      unsubscribe();
      await delivery;
    }),
  );
});

export const listAddProposals = makeIpcMethod({
  channel: Channels.LOCAL_MCP_LIST_ADD_PROPOSALS_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(LocalMcpAddProposal),
  handler: Effect.fn(function* () {
    return (yield* RemoteControlRequestRouter).router.listAddProposals();
  }),
});
export const resolveAddProposal = makeIpcMethod({
  channel: Channels.LOCAL_MCP_RESOLVE_ADD_PROPOSAL_CHANNEL,
  payload: LocalMcpAddDecision,
  result: Schema.Void,
  handler: Effect.fn(function* (decision) {
    const { router } = yield* RemoteControlRequestRouter;
    yield* nativeCall(() => router.resolveAddProposal(decision));
  }),
});
export const installProposalEventForwarding = Effect.fn(function* () {
  const { router } = yield* RemoteControlRequestRouter;
  const windows = yield* ElectronWindow;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  let delivery = Promise.resolve();
  const off = router.onAddProposalsChanged((proposals) => {
    delivery = delivery
      .then(() => run(windows.sendAll(Channels.LOCAL_MCP_ADD_PROPOSALS_CHANGED_CHANNEL, proposals)))
      .catch((cause) => run(Effect.logWarning("MCP proposal IPC forwarding failed", cause)));
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      off();
      await delivery;
    }),
  );
});
