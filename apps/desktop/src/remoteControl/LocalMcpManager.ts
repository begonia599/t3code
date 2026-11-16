/* eslint-disable unicorn/prefer-add-event-listener -- MCP SDK transports use callback properties. */
// @effect-diagnostics nodeBuiltinImport:off -- Native SDK process cleanup at the desktop adapter boundary.
// @effect-diagnostics globalTimers:off -- AbortSignal deadlines also cover queued native SDK calls.
// @effect-diagnostics globalDate:off -- Native manager publishes durable wall-clock catalog timestamps.
import {
  DESKTOP_MCP_CALL_TIMEOUT_MS,
  DESKTOP_MCP_MAX_CONCURRENT_CALLS,
  DESKTOP_MCP_MAX_RESULT_BYTES,
  DESKTOP_MCP_VERSION,
  LocalMcpServerConfig,
  type DesktopChannelCapabilities,
  DesktopMcpCallResult,
  type DesktopMcpProgress,
  type LocalMcpProbeResult,
  type LocalMcpServerView,
  type LocalMcpTool,
} from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { DesktopAppSettings } from "../settings/DesktopAppSettings.ts";
import { mergedEnvironment, killWindowsProcessTree } from "./nativeProcesses.ts";

export class LocalMcpError extends Error {
  readonly code: string;
  constructor(code: string, message = code) {
    super(message);
    this.code = code;
  }
}
const decodeConfig = Schema.decodeUnknownSync(LocalMcpServerConfig);
const decodeResult = Schema.decodeUnknownSync(DesktopMcpCallResult);
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Abort even while waiting for a slot or a backpressured progress consumer. */
function abortable<A>(work: Promise<A>, signal: AbortSignal): Promise<A> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

function deadline(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const abort = () => controller.abort(new LocalMcpError("CANCELLED"));
  parent.addEventListener("abort", abort, { once: true });
  if (parent.aborted) abort();
  const timer = setTimeout(() => controller.abort(new LocalMcpError("TIMEOUT")), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    },
  };
}

async function listTools(client: Client, signal: AbortSignal): Promise<LocalMcpTool[]> {
  const tools: LocalMcpTool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor }, { signal });
    tools.push(...page.tools);
    cursor = page.nextCursor;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error("MCP tools/list repeated a cursor");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return tools;
}

function createSession(config: LocalMcpServerConfig, platform: NodeJS.Platform) {
  const client = new Client({ name: "t3-desktop", version: DESKTOP_MCP_VERSION });
  const transport =
    config.transport.type === "stdio"
      ? new StdioClientTransport({
          command: config.transport.command,
          args: [...config.transport.args],
          cwd: config.transport.cwd ?? NodeOS.homedir(),
          env: Object.fromEntries(
            Object.entries(mergedEnvironment(config.transport.env, platform)).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          stderr: "pipe",
        })
      : new StreamableHTTPClientTransport(new URL(config.transport.url), {
          requestInit: { headers: { ...config.transport.headers } },
        });
  let stderr = Buffer.alloc(0);
  if (transport instanceof StdioClientTransport) {
    transport.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = Buffer.concat([stderr, Buffer.from(chunk)]).subarray(-4096);
    });
  }
  let closing: Promise<void> | undefined;
  let spawnedPid: number | null = null;
  return {
    client,
    transport,
    connect: async (signal: AbortSignal) => {
      // SDK 1.29's HTTP sessionId is typed as required-but-undefined while Transport uses an optional field.
      const connection = client.connect(transport as Parameters<Client["connect"]>[0], { signal });
      // start() spawns synchronously; retain our PID even if initialization closes the transport.
      if (transport instanceof StdioClientTransport) spawnedPid = transport.pid;
      await connection;
      const receive = transport.onmessage;
      let incoming = Promise.resolve();
      // SDK notification handlers run in a microtask. Preserve wire order when stdio delivers
      // progress and its result in one chunk, before the result removes the progress token.
      transport.onmessage = (...args) => {
        incoming = incoming
          .then(() => {
            receive?.(...args);
          })
          .catch((cause: unknown) => {
            transport.onerror?.(new Error(message(cause)));
          });
      };
    },
    error: (cause: unknown) =>
      `${message(cause)}${stderr.length ? `\n${stderr.toString("utf8")}` : ""}`,
    close: () =>
      (closing ??= (async () => {
        // Capture only our own child PID, before the SDK clears it during close.
        const pid =
          transport instanceof StdioClientTransport ? (transport.pid ?? spawnedPid) : null;
        await client.close().catch(() => {});
        // connect may have failed before Client attached the transport.
        await transport.close().catch(() => {});
        if (platform === "win32" && pid !== null) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }

          await new Promise<void>((resolve) => {
            const killer = killWindowsProcessTree(pid);
            killer.once("error", () => resolve());
            killer.once("close", () => resolve());
          });
        }
      })()),
  };
}

type Session = ReturnType<typeof createSession>;
type Entry = {
  config: LocalMcpServerConfig;
  status: LocalMcpServerView["status"];
  tools: readonly LocalMcpTool[];
  error?: string;
  toolsUpdatedAt?: string;
  session?: Session;
  lifetime: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  attempts: number;
};

export function createLocalMcpManager(options: {
  readonly save: (configs: readonly LocalMcpServerConfig[]) => Promise<unknown>;
  readonly platform?: NodeJS.Platform;
  readonly callTimeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly retryDelaysMs?: readonly number[];
}) {
  const platform = options.platform ?? HostProcessPlatform.defaultValue();
  const entries = new Map<string, Entry>();
  const listeners = new Set<(views: readonly LocalMcpServerView[]) => void>();
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const track = <A>(promise: Promise<A>) => {
    pending.add(promise);
    void promise.finally(() => pending.delete(promise)).catch(() => {});
    return promise;
  };
  let active = 0;
  const queue: Array<{ wake: () => void }> = [];
  let mutations = Promise.resolve();
  const views = (): readonly LocalMcpServerView[] =>
    [...entries.values()].map((entry) => ({
      config: entry.config,
      status: entry.status,
      tools: entry.tools,
      ...(entry.error === undefined ? {} : { error: entry.error }),
      ...(entry.toolsUpdatedAt === undefined ? {} : { toolsUpdatedAt: entry.toolsUpdatedAt }),
    }));
  const publish = () => {
    const snapshot = views();
    for (const listener of listeners) listener(snapshot);
  };
  const current = (entry: Entry, session: Session) =>
    !shutdown.signal.aborted && !entry.lifetime.signal.aborted && entry.session === session;
  const stop = async (entry: Entry) => {
    entry.lifetime.abort();
    clearTimeout(entry.timer);
    const session = entry.session;
    delete entry.session;
    await session?.close();
  };
  const start = async (entry: Entry) => {
    if (shutdown.signal.aborted || entry.lifetime.signal.aborted) return;
    entry.status = "starting";
    delete entry.error;
    publish();
    let session: Session;
    const failed = async (cause: unknown) => {
      if (session && !current(entry, session)) return;
      if (shutdown.signal.aborted || entry.lifetime.signal.aborted) return;
      delete entry.session;
      entry.status = "failed";
      entry.error = session ? session.error(cause) : message(cause);
      publish();
      await session?.close();
      if (shutdown.signal.aborted || entry.lifetime.signal.aborted) return;
      const delays = options.retryDelaysMs ?? [1000, 2000, 5000, 10000, 30000];
      entry.timer = setTimeout(
        () => {
          track(start(entry));
        },
        delays[Math.min(entry.attempts++, delays.length - 1)] ?? 30000,
      );
    };
    try {
      session = createSession(entry.config, platform);
      entry.session = session;
      const sessionSignal = AbortSignal.any([shutdown.signal, entry.lifetime.signal]);
      let refresh = Promise.resolve();
      const refreshTools = () => {
        refresh = refresh.then(async () => {
          const tools = await listTools(session.client, sessionSignal);
          if (!current(entry, session)) return;
          const changed = !NodeUtil.isDeepStrictEqual(tools, entry.tools);
          entry.tools = tools;
          entry.toolsUpdatedAt = new Date().toISOString();
          if (changed) publish();
        });
        return refresh;
      };
      session.client.onclose = () => {
        track(failed(new Error("MCP transport closed")));
      };
      session.transport.onerror = (cause) => {
        track(failed(cause));
      };
      session.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        track(refreshTools().catch(failed));
      });
      const startup = deadline(sessionSignal, options.probeTimeoutMs ?? 20000);
      try {
        await abortable(session.connect(startup.signal), startup.signal);
        const tools = await abortable(listTools(session.client, startup.signal), startup.signal);
        if (!current(entry, session)) return;
        entry.tools = tools;
        entry.toolsUpdatedAt = new Date().toISOString();
        entry.status = "running";
        entry.attempts = 0;
        publish();
      } finally {
        startup.dispose();
      }
    } catch (cause) {
      await failed(cause);
    }
  };
  const configure = async (configs: readonly LocalMcpServerConfig[], forceId?: string) => {
    // Replacements reinsert ids; iterate a snapshot so the Map cannot revisit them.
    const previousEntries = [...entries];
    for (const [id, entry] of previousEntries) {
      const config = configs.find((config) => config.id === id);
      if (id !== forceId && config && JSON.stringify(config) === JSON.stringify(entry.config))
        continue;
      await stop(entry);
      entries.delete(id);
      if (config)
        entries.set(id, {
          config,
          status: "stopped",
          tools: entry.tools,
          ...(entry.toolsUpdatedAt ? { toolsUpdatedAt: entry.toolsUpdatedAt } : {}),
          lifetime: new AbortController(),
          attempts: 0,
        });
    }
    for (const config of configs) {
      if (!entries.has(config.id))
        entries.set(config.id, {
          config,
          status: "stopped",
          tools: [],
          lifetime: new AbortController(),
          attempts: 0,
        });
    }
    publish();
    for (const entry of entries.values()) {
      if (entry.config.enabled && entry.status === "stopped") track(start(entry));
    }
    return views();
  };
  const mutate = (
    change: (configs: readonly LocalMcpServerConfig[]) => readonly LocalMcpServerConfig[],
    forceId?: string,
  ) => {
    const result = mutations.then(async () => {
      if (shutdown.signal.aborted) throw new Error("Local MCP manager is closed");
      const configs = change([...entries.values()].map((entry) => entry.config));
      await options.save(configs);
      return configure(configs, forceId);
    });
    mutations = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const requireEntry = (id: string) => {
    const entry = entries.get(id);
    if (!entry) throw new LocalMcpError("MCP_SERVER_NOT_FOUND", `Unknown local MCP server: ${id}`);
    return entry;
  };
  const acquire = (signal: AbortSignal) => {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (active < DESKTOP_MCP_MAX_CONCURRENT_CALLS) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        wake: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      queue.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
    });
  };
  const release = () => {
    const next = queue.shift();
    if (next) next.wake();
    else active--;
  };
  return {
    views,
    capabilities: (): NonNullable<DesktopChannelCapabilities["mcp"]> => ({
      version: DESKTOP_MCP_VERSION,
      servers: views()
        .filter((view) => view.config.enabled)
        .map((view) => ({
          id: view.config.id,
          name: view.config.name,
          status: view.status,
          tools: view.tools,
        })),
    }),
    onChanged: (listener: (views: readonly LocalMcpServerView[]) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize: (configs: readonly LocalMcpServerConfig[]) => configure(configs),
    upsert: (config: LocalMcpServerConfig) => {
      const decoded = decodeConfig(config);
      return mutate(
        (configs) => [...configs.filter((item) => item.id !== decoded.id), decoded],
        decoded.id,
      );
    },
    remove: (id: string) => mutate((configs) => configs.filter((config) => config.id !== id)),
    setEnabled: (id: string, enabled: boolean) =>
      mutate((configs) => {
        requireEntry(id);
        return configs.map((config) => (config.id === id ? { ...config, enabled } : config));
      }),
    restart: (id: string) =>
      mutate((configs) => {
        requireEntry(id);
        return configs;
      }, id),
    call: async (
      serverId: string,
      toolName: string,
      args: Record<string, unknown> | undefined,
      parent: AbortSignal,
      onProgress: (progress: DesktopMcpProgress) => Promise<void> = async () => {},
    ): Promise<DesktopMcpCallResult> => {
      const limit = deadline(
        AbortSignal.any([parent, shutdown.signal]),
        options.callTimeoutMs ?? DESKTOP_MCP_CALL_TIMEOUT_MS,
      );
      let acquired = false;
      try {
        await acquire(limit.signal);
        acquired = true;
        if (limit.signal.aborted) throw limit.signal.reason;
        const entry = requireEntry(serverId);
        if (!entry.config.enabled) throw new LocalMcpError("MCP_SERVER_DISABLED");
        if (entry.status !== "running" || !entry.session)
          throw new LocalMcpError("MCP_SERVER_UNAVAILABLE", entry.error);
        if (!entry.tools.some((tool) => tool.name === toolName))
          throw new LocalMcpError("MCP_TOOL_NOT_FOUND");
        let progress = Promise.resolve();
        const timeout = options.callTimeoutMs ?? DESKTOP_MCP_CALL_TIMEOUT_MS;
        const result = await abortable(
          entry.session.client.callTool(
            { name: toolName, ...(args ? { arguments: args } : {}) },
            CallToolResultSchema,
            {
              signal: limit.signal,
              timeout,
              maxTotalTimeout: timeout,
              resetTimeoutOnProgress: false,
              onprogress: (value) => {
                progress = progress.then(() => onProgress(value));
                void progress.catch(() => {});
              },
            },
          ),
          limit.signal,
        );
        await abortable(progress, limit.signal);
        if (Buffer.byteLength(JSON.stringify(result), "utf8") > DESKTOP_MCP_MAX_RESULT_BYTES)
          throw new LocalMcpError("MCP_RESULT_TOO_LARGE");
        return decodeResult(result);
      } catch (cause) {
        if (limit.signal.aborted) throw limit.signal.reason;
        if (cause instanceof LocalMcpError) throw cause;
        throw new LocalMcpError("MCP_PROTOCOL_ERROR", message(cause));
      } finally {
        if (acquired) release();
        limit.dispose();
      }
    },
    probe: (config: LocalMcpServerConfig): Promise<LocalMcpProbeResult> =>
      track(
        (async (): Promise<LocalMcpProbeResult> => {
          const limit = deadline(shutdown.signal, options.probeTimeoutMs ?? 20000);
          let session: Session | undefined;
          try {
            session = createSession(decodeConfig(config), platform);
            await abortable(session.connect(limit.signal), limit.signal);
            const tools = await abortable(listTools(session.client, limit.signal), limit.signal);
            const info = session.client.getServerVersion();
            await abortable(session.close(), limit.signal);
            return {
              ok: true,
              tools,
              ...(info ? { serverName: info.name, serverVersion: info.version } : {}),
            };
          } catch (cause) {
            return { ok: false, error: session ? session.error(cause) : message(cause) };
          } finally {
            limit.dispose();
            // The caller deadline includes cleanup; finalization still waits for any SDK grace period.
            if (session) track(session.close());
          }
        })(),
      ),
    dispose: async () => {
      shutdown.abort();
      await mutations;
      await Promise.all([...entries.values()].map(stop));
      while (pending.size) await Promise.allSettled(pending);
      listeners.clear();
    },
  };
}

export class LocalMcpManager extends Context.Service<
  LocalMcpManager,
  ReturnType<typeof createLocalMcpManager>
>()("@t3tools/desktop/remoteControl/LocalMcpManager") {}
export const layer = Layer.effect(
  LocalMcpManager,
  Effect.gen(function* () {
    const settings = yield* DesktopAppSettings;
    const platform = yield* HostProcessPlatform;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const manager = createLocalMcpManager({
      platform,
      save: (configs) => run(settings.setLocalMcpServers(configs)),
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
    return manager;
  }),
);
