// @effect-diagnostics globalDate:off -- Native request deadlines and renderer timestamps.
// @effect-diagnostics nodeBuiltinImport:off -- Main owns unguessable proposal identities.
// @effect-diagnostics globalTimers:off -- Promise handlers own native confirmation and startup deadlines.
import * as NodeCrypto from "node:crypto";
import {
  DESKTOP_EXEC_GRANT_WAIT_MS,
  DESKTOP_MCP_ADD_KIND,
  DESKTOP_MCP_ADD_STARTUP_WAIT_MS,
  DESKTOP_MCP_LIST_KIND,
  DesktopMcpAddInput,
  DesktopMcpListInput,
  type DesktopMcpAddResult,
  type DesktopMcpListResult,
  type LocalMcpAddDecision,
  type LocalMcpAddProposal,
  type LocalMcpDiscoveryResult,
  type LocalMcpServerConfig,
  type LocalMcpServerView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { LocalMcpError, type LocalMcpManager } from "./LocalMcpManager.ts";
import { serverId, transportKey } from "./LocalMcpDiscovery.ts";
import type { RequestHandler } from "./RemoteControlRequestRouter.ts";

const summary = (view: LocalMcpServerView): DesktopMcpAddResult => ({
  id: view.config.id,
  name: view.config.name,
  status: view.status,
  ...(view.errorKind ? { errorKind: view.errorKind } : {}),
  toolCount: view.tools.length,
  toolPrefix: `mcp__t3-win__${view.config.id}__`,
});
const decodeAdd = Schema.decodeUnknownSync(DesktopMcpAddInput, { onExcessProperty: "error" });
const decodeList = Schema.decodeUnknownSync(DesktopMcpListInput, { onExcessProperty: "error" });

/** Main-only proposal queue; raw credentials never enter a renderer or channel response. */
export function createLocalMcpManagement(options: {
  manager: Pick<LocalMcpManager["Service"], "views" | "upsert" | "onChanged">;
  enabledEnvironmentIds: () => Promise<readonly string[]>;
  discover: () => Promise<LocalMcpDiscoveryResult>;
}) {
  const manager = options.manager;
  const listeners = new Set<(proposals: readonly LocalMcpAddProposal[]) => void>();
  type Pending = {
    proposal: LocalMcpAddProposal;
    config: LocalMcpServerConfig;
    key: string;
    deciding: boolean;
    lifetime: AbortController;
    waiters: Set<{
      resolve: (result: DesktopMcpAddResult) => void;
      reject: (error: unknown) => void;
      off: () => void;
    }>;
    timer: ReturnType<typeof setTimeout>;
  };
  const pending = new Map<string, Pending>();
  const listAddProposals = () =>
    [...pending.values()].filter((p) => !p.deciding).map((p) => p.proposal);
  const changed = () => {
    const proposals = listAddProposals();
    for (const listener of listeners) listener(proposals);
  };
  const finish = (state: Pending, result: DesktopMcpAddResult | undefined, error?: unknown) => {
    if (!pending.delete(state.proposal.proposalId)) return;
    clearTimeout(state.timer);
    state.lifetime.abort();
    for (const waiter of state.waiters) {
      waiter.off();
      if (result) waiter.resolve(result);
      else waiter.reject(error);
    }
    state.waiters.clear();
    changed();
  };
  const enabled = async (environmentId: string) => {
    if (!(await options.enabledEnvironmentIds()).includes(environmentId))
      throw new LocalMcpError("REMOTE_DISABLED", "Remote control is disabled for this environment");
  };
  const list: RequestHandler = async ({
    environmentId,
    request,
    signal,
  }): Promise<DesktopMcpListResult> => {
    await enabled(environmentId);
    try {
      decodeList(request.input);
    } catch {
      throw new LocalMcpError("BAD_REQUEST", "Invalid MCP list request");
    }
    const discovery = await options.discover();
    if (signal.aborted) throw new LocalMcpError("CANCELLED", "MCP list cancelled");
    return {
      servers: manager.views().map((view) => ({
        id: view.config.id,
        name: view.config.name,
        enabled: view.config.enabled,
        status: view.status,
        ...(view.errorKind ? { errorKind: view.errorKind } : {}),
        toolCount: view.tools.length,
      })),
      candidates: discovery.servers
        .filter((server) => !server.addedAs)
        .map(({ key, config, sources }) => {
          const transport = config.transport;
          return {
            key,
            name: config.name,
            apps: [...new Set(sources.map((source) => source.app))],
            ...(transport.type === "stdio"
              ? {
                  transport: {
                    type: "stdio" as const,
                    command: transport.command.split(/[\\/]/).at(-1) ?? "",
                  },
                  envNames: Object.keys(transport.env),
                }
              : {
                  transport: { type: "http" as const, origin: new URL(transport.url).origin },
                  headerNames: Object.keys(transport.headers),
                }),
          };
        }),
      skipped: discovery.skipped.length,
    };
  };
  const add: RequestHandler = async ({ environmentId, request, signal }) => {
    await enabled(environmentId);
    let input: DesktopMcpAddInput;
    try {
      input = decodeAdd(request.input);
    } catch {
      throw new LocalMcpError("BAD_REQUEST", "Invalid MCP configuration");
    }
    let config: LocalMcpServerConfig;
    let sources: LocalMcpAddProposal["sources"];
    if ("key" in input) {
      const discovered = (await options.discover()).servers.find(
        (server) => server.key === input.key,
      );
      if (!discovered)
        throw new LocalMcpError(
          "MCP_SERVER_NOT_FOUND",
          "No MCP with this key is set up in other apps on the PC; run `win mcp list` for current keys",
        );
      if (signal.aborted) throw new LocalMcpError("CANCELLED", "MCP add cancelled");
      const existing =
        discovered.addedAs && manager.views().find((view) => view.config.id === discovered.addedAs);
      if (existing) return summary(existing);
      config = discovered.config;
      sources = discovered.sources;
    } else {
      const transport = input.config.transport;
      config = {
        id: input.config.id ?? serverId(input.config.name),
        name: input.config.name,
        enabled: true,
        transport:
          transport.type === "stdio"
            ? { ...transport, env: transport.env ?? {} }
            : { ...transport, headers: transport.headers ?? {} },
      };
    }
    if (signal.aborted) throw new LocalMcpError("CANCELLED", "MCP add cancelled");
    const key = JSON.stringify([
      environmentId,
      request.context.threadId ?? null,
      "key" in input
        ? ["key", input.key]
        : ["config", config.id, config.name, transportKey(config.transport)],
    ]);
    let state = [...pending.values()].find((item) => item.key === key);
    if (!state) {
      if (listAddProposals().length >= 5)
        throw new LocalMcpError("HOST_BUSY", "There are already 5 pending MCP add proposals");
      const used = new Set([
        ...manager.views().map((view) => view.config.id),
        ...[...pending.values()].map((p) => p.config.id),
      ]);
      const base = config.id;
      let id = base;
      for (let suffix = 2; used.has(id); suffix++) {
        const ending = `-${suffix}`;
        id = `${base.slice(0, 24 - ending.length)}${ending}`;
      }
      config = { ...config, id, enabled: true };
      const transport = config.transport;
      // Values from other apps' configs stay in main; values the agent wrote are shown for review.
      const agentWritten = !("key" in input);
      const now = Date.now();
      const proposal: LocalMcpAddProposal = {
        proposalId: NodeCrypto.randomUUID(),
        environmentId,
        threadId: request.context.threadId ?? null,
        provider: request.context.provider ?? null,
        label: request.context.label ?? null,
        origin: "key" in input ? "discovered" : "agent",
        ...(sources ? { sources } : {}),
        id,
        name: config.name,
        transport:
          transport.type === "stdio"
            ? {
                type: "stdio",
                command: transport.command,
                args: transport.args,
                ...(transport.cwd === undefined ? {} : { cwd: transport.cwd }),
                envNames: Object.keys(transport.env),
                ...(agentWritten ? { env: transport.env } : {}),
              }
            : {
                type: "http",
                url: transport.url,
                headerNames: Object.keys(transport.headers),
                ...(agentWritten ? { headers: transport.headers } : {}),
              },
        requestedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + DESKTOP_EXEC_GRANT_WAIT_MS).toISOString(),
      };
      const created: Pending = {
        proposal,
        config,
        key,
        deciding: false,
        lifetime: new AbortController(),
        waiters: new Set(),
        timer: setTimeout(
          () =>
            finish(
              created,
              undefined,
              new LocalMcpError("TIMEOUT", "The user did not confirm on the PC in time"),
            ),
          DESKTOP_EXEC_GRANT_WAIT_MS,
        ),
      };
      state = created;
      pending.set(proposal.proposalId, created);
    }
    const current = state;
    return new Promise<DesktopMcpAddResult>((resolve, reject) => {
      const abort = () => {
        current.waiters.delete(waiter);
        waiter.off();
        reject(new LocalMcpError("CANCELLED", "MCP add cancelled"));
        if (!current.waiters.size && !current.deciding) finish(current, undefined);
      };
      const waiter = { resolve, reject, off: () => signal.removeEventListener("abort", abort) };
      current.waiters.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else changed();
    });
  };
  const waitForStartup = (state: Pending): Promise<DesktopMcpAddResult> =>
    new Promise((resolve, reject) => {
      const id = state.config.id;
      const signal = state.lifetime.signal;
      const abort = () => {
        done();
        reject(new LocalMcpError("CANCELLED", "MCP startup wait cancelled"));
      };
      const complete = () => {
        const view = manager.views().find((item) => item.config.id === id);
        if (view && (view.status === "running" || view.status === "failed")) {
          done();
          resolve(summary(view));
        }
      };
      const off = manager.onChanged(complete);
      const timer = setTimeout(() => {
        done();
        const view = manager.views().find((item) => item.config.id === id);
        if (view) resolve(summary(view));
        else
          reject(
            new LocalMcpError("MCP_SERVER_NOT_FOUND", "MCP server was removed during startup"),
          );
      }, DESKTOP_MCP_ADD_STARTUP_WAIT_MS[state.config.transport.type]);
      const done = () => {
        clearTimeout(timer);
        off();
        signal.removeEventListener("abort", abort);
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else complete();
    });
  return {
    handlers: { [DESKTOP_MCP_LIST_KIND]: list, [DESKTOP_MCP_ADD_KIND]: add },
    listAddProposals,
    async resolveAddProposal(decision: LocalMcpAddDecision) {
      const state = pending.get(decision.proposalId);
      if (!state || state.deciding)
        throw new LocalMcpError("BAD_REQUEST", "Unknown or expired MCP add proposal");
      if (Date.now() >= Date.parse(state.proposal.expiresAt)) {
        finish(
          state,
          undefined,
          new LocalMcpError("TIMEOUT", "The user did not confirm on the PC in time"),
        );
        throw new LocalMcpError("BAD_REQUEST", "Expired MCP add proposal");
      }
      state.deciding = true;
      clearTimeout(state.timer);
      changed();
      if (decision.decision === "deny") {
        finish(state, undefined, new LocalMcpError("GRANT_DENIED", "MCP add denied by the user"));
        return;
      }
      // A decision is consumed immediately; IPC does not wait for the MCP connection.
      void (async () => {
        try {
          await enabled(state.proposal.environmentId);
          if (state.lifetime.signal.aborted)
            throw new LocalMcpError("CANCELLED", "MCP add cancelled");
          if (manager.views().some((view) => view.config.id === state.config.id))
            throw new LocalMcpError(
              "HOST_BUSY",
              "MCP id was taken while awaiting confirmation; propose again",
            );
          await manager.upsert(state.config);
          finish(state, await waitForStartup(state));
        } catch (error) {
          finish(state, undefined, error);
        }
      })();
    },
    onAddProposalsChanged(listener: (proposals: readonly LocalMcpAddProposal[]) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      for (const state of pending.values())
        finish(state, undefined, new LocalMcpError("CANCELLED", "Desktop shutting down"));
      listeners.clear();
    },
  };
}
