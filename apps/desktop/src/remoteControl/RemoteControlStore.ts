// @effect-diagnostics nodeBuiltinImport:off -- Native filesystem and process adapter behind an Effect service.
// @effect-diagnostics globalTimers:off -- Promise handlers use AbortSignal and native process/grant deadlines.
// @effect-diagnostics globalDate:off -- Durable timestamps at the native request boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DESKTOP_EXEC_GRANT_WAIT_MS,
  DESKTOP_EXEC_LOG_RETAINED,
  DesktopExecLogEntry,
  RemoteControlGrant,
  type RemoteControlGrantRequest,
  type RemoteControlGrantDecision,
} from "@t3tools/contracts";
import { DesktopEnvironment } from "../app/DesktopEnvironment.ts";
import { ElectronWindow } from "../electron/ElectronWindow.ts";
import * as Channels from "../ipc/channels.ts";

const decodeGrants = Schema.decodeUnknownSync(Schema.Array(RemoteControlGrant));
const decodeAuditEntry = Schema.decodeUnknownSync(DesktopExecLogEntry);

const IDLE_MS = 7 * 24 * 60 * 60_000;
const DENIED_MS = 10 * 60_000;
type GrantInput = Omit<
  RemoteControlGrantRequest,
  "grantRequestId" | "requestedAt" | "expiresAt" | "requestCount"
>;
const keyOf = (environmentId: string, threadId: string) =>
  JSON.stringify([environmentId, threadId]);
const failure = (code: string, message = code) => Object.assign(new Error(message), { code });

export async function createRemoteControlStore(options: {
  stateDir: string;
  now?: () => number;
  onGrantsChanged?: (grants: readonly RemoteControlGrant[]) => void;
  onPendingChanged?: (pending: readonly RemoteControlGrantRequest[]) => void;
  onAttention?: () => void;
}) {
  const now = options.now ?? Date.now;
  const grantsPath = NodePath.join(options.stateDir, "remote-control-grants.json");
  const auditPath = NodePath.join(options.stateDir, "remote-control-audit.jsonl");
  const grants = new Map<string, RemoteControlGrant>();
  const denied = new Map<string, number>();
  type Waiter = {
    input: GrantInput;
    resolve: () => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  };
  type Pending = { request: RemoteControlGrantRequest; waiters: Waiter[]; resolving: boolean };
  const pending = new Map<string, Pending>();
  let grantWrites = Promise.resolve();
  let auditWrites = Promise.resolve();
  const atomicWrite = async (file: string, data: string) => {
    await NodeFSP.mkdir(options.stateDir, { recursive: true });
    const temp = `${file}.${NodeCrypto.randomUUID()}.tmp`;
    try {
      await NodeFSP.writeFile(temp, data);
      await NodeFSP.rename(temp, file);
    } finally {
      await NodeFSP.rm(temp, { force: true }).catch(() => {});
    }
  };
  try {
    const records = decodeGrants(JSON.parse(await NodeFSP.readFile(grantsPath, "utf8")));
    for (const record of records)
      if (now() - Date.parse(record.lastUsedAt) < IDLE_MS)
        grants.set(keyOf(record.environmentId, record.threadId), record);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const listGrants = () => {
    for (const [key, grant] of grants)
      if (now() - Date.parse(grant.lastUsedAt) >= IDLE_MS) grants.delete(key);
    return [...grants.values()];
  };
  const persistGrants = () => {
    const data = JSON.stringify(listGrants());
    const write = grantWrites.then(() => atomicWrite(grantsPath, data));
    grantWrites = write.catch(() => {});
    return write;
  };
  const publishGrants = () => options.onGrantsChanged?.(listGrants());
  const getPendingGrantRequests = () =>
    [...pending.values()].map(({ request, waiters }) => ({
      ...request,
      requestCount: waiters.length,
    }));
  const publishPending = () => options.onPendingChanged?.(getPendingGrantRequests());
  const removeWaiter = (group: Pending, waiter: Waiter, error?: Error) => {
    group.waiters = group.waiters.filter((w) => w !== waiter);
    waiter.cleanup();
    if (!group.waiters.length) pending.delete(group.request.grantRequestId);
    if (error) waiter.reject(error);
    else waiter.resolve();
  };
  const rejectGroup = (group: Pending, error: Error) => {
    for (const waiter of group.waiters) removeWaiter(group, waiter, error);
  };
  const grantState = (
    environmentId: string,
    threadId?: string | null,
  ): "granted" | "none" | "denied" => {
    if (!threadId) return "none";
    const key = keyOf(environmentId, threadId);
    if ((denied.get(key) ?? 0) > now()) return "denied";
    denied.delete(key);
    listGrants();
    return grants.has(key) ? "granted" : "none";
  };
  const authorize = async (
    input: GrantInput,
    signal: AbortSignal,
    awaiting: () => Promise<void>,
  ) => {
    if (signal.aborted) throw failure("CANCELLED");
    const state = grantState(input.environmentId, input.threadId);
    if (state === "denied")
      throw failure("GRANT_DENIED", "This thread was denied within the last ten minutes");
    if (!input.strictMode && state === "granted" && input.threadId) {
      const key = keyOf(input.environmentId, input.threadId);
      grants.set(key, { ...grants.get(key)!, lastUsedAt: new Date(now()).toISOString() });
      await persistGrants();
      publishGrants();
      return;
    }
    // Creating the pending request precedes the progress emit so its deadline also
    // covers a stalled renderer / remote consumer. A rejection is observed immediately.
    const waiting = new Promise<void>((resolve, reject) => {
      let group =
        !input.strictMode && input.threadId
          ? [...pending.values()].find(
              (p) =>
                !p.resolving &&
                !p.request.strictMode &&
                p.request.environmentId === input.environmentId &&
                p.request.threadId === input.threadId,
            )
          : undefined;
      const created = !group;
      if (!group) {
        const timestamp = now();
        group = {
          request: {
            ...input,
            grantRequestId: NodeCrypto.randomUUID(),
            requestedAt: new Date(timestamp).toISOString(),
            expiresAt: new Date(timestamp + DESKTOP_EXEC_GRANT_WAIT_MS).toISOString(),
            requestCount: 1,
          },
          waiters: [],
          resolving: false,
        };
        pending.set(group.request.grantRequestId, group);
      }
      const target = group;
      const abort = () => {
        removeWaiter(target, waiter, failure("CANCELLED"));
        publishPending();
      };
      const timer = setTimeout(
        () => {
          removeWaiter(target, waiter, failure("GRANT_TIMEOUT"));
          publishPending();
        },
        Math.max(0, Date.parse(target.request.expiresAt) - now()),
      );
      const waiter: Waiter = {
        input,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener("abort", abort);
        },
      };
      target.waiters.push(waiter);
      signal.addEventListener("abort", abort, { once: true });
      publishPending();
      if (created) options.onAttention?.();
    });
    try {
      await Promise.all([waiting, awaiting()]);
    } catch (error) {
      // An emit failure is normally cancellation; remove its pending waiter too.
      for (const group of pending.values())
        for (const waiter of group.waiters)
          if (waiter.input === input) removeWaiter(group, waiter, failure("CANCELLED"));
      publishPending();
      throw error;
    }
  };
  const resolveGrant = async ({ grantRequestId, decision }: RemoteControlGrantDecision) => {
    const group = pending.get(grantRequestId);
    if (!group || group.resolving || Date.parse(group.request.expiresAt) <= now())
      throw new Error("Unknown or expired grant request id");
    const request = group.request;
    if (decision === "allow-session" && (request.strictMode || !request.threadId))
      throw new Error("Session grants are unavailable in strict mode or without a thread");
    group.resolving = true;
    if (decision === "allow-session" && request.threadId) {
      const key = keyOf(request.environmentId, request.threadId);
      const timestamp = new Date(now()).toISOString();
      const record = {
        environmentId: request.environmentId,
        threadId: request.threadId,
        provider: request.provider,
        label: request.label,
        grantedAt: timestamp,
        lastUsedAt: timestamp,
      };
      grants.set(key, record);
      try {
        await persistGrants();
      } catch (error) {
        grants.delete(key);
        group.resolving = false;
        throw error;
      }
      // Disabling the environment or cancellation while persisting must not resurrect a grant.
      if (!pending.has(grantRequestId)) {
        grants.delete(key);
        await persistGrants();
        publishGrants();
        return;
      }
      publishGrants();
      for (const waiter of group.waiters) removeWaiter(group, waiter);
    } else if (decision === "deny") {
      if (request.threadId)
        denied.set(keyOf(request.environmentId, request.threadId), now() + DENIED_MS);
      rejectGroup(group, failure("GRANT_DENIED"));
    } else {
      removeWaiter(group, group.waiters[0]!);
      // "Once" releases one command, never every command hidden in a merged dialog.
      if (group.waiters.length) {
        pending.delete(grantRequestId);
        group.request = {
          ...group.request,
          ...group.waiters[0]!.input,
          grantRequestId: NodeCrypto.randomUUID(),
        };
        group.resolving = false;
        pending.set(group.request.grantRequestId, group);
        options.onAttention?.();
      }
    }
    publishPending();
  };
  const readRows = async () => {
    let raw: string;
    try {
      raw = await NodeFSP.readFile(auditPath, "utf8");
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return { lines: 0, entries: [] as DesktopExecLogEntry[] };
      throw error;
    }
    const rows = raw.split("\n").filter(Boolean);
    const records = new Map<string, DesktopExecLogEntry>();
    for (const line of rows) {
      try {
        const entry = decodeAuditEntry(JSON.parse(line));
        records.set(entry.requestId, entry);
      } catch {
        /* A crash can leave the final append incomplete. */
      }
    }
    return {
      lines: rows.length,
      entries: [...records.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    };
  };
  return {
    authorize,
    resolveGrant,
    grantState,
    listGrants,
    getPendingGrantRequests,
    async revokeGrant(input: { environmentId: string; threadId: string }) {
      grants.delete(keyOf(input.environmentId, input.threadId));
      for (const group of pending.values())
        if (
          group.request.environmentId === input.environmentId &&
          group.request.threadId === input.threadId
        )
          rejectGroup(group, failure("GRANT_DENIED"));
      await persistGrants();
      publishGrants();
      publishPending();
    },
    rejectEnvironment(environmentId?: string) {
      for (const group of pending.values())
        if (environmentId === undefined || group.request.environmentId === environmentId)
          rejectGroup(group, failure("GRANT_DENIED", "Remote control was disabled"));
      publishPending();
    },
    appendAudit(entry: DesktopExecLogEntry) {
      auditWrites = auditWrites
        .then(async () => {
          await NodeFSP.mkdir(options.stateDir, { recursive: true });
          await NodeFSP.appendFile(auditPath, `${JSON.stringify(entry)}\n`);
          const rows = await readRows();
          if (rows.lines > 1000)
            await atomicWrite(
              auditPath,
              rows.entries
                .slice(0, DESKTOP_EXEC_LOG_RETAINED)
                .map((r) => JSON.stringify(r))
                .join("\n") + "\n",
            );
        })
        .catch(() => {});
      return auditWrites;
    },
    async readAudit({ limit }: { limit: number }) {
      await auditWrites;
      return (await readRows()).entries.slice(
        0,
        Math.max(0, Math.min(DESKTOP_EXEC_LOG_RETAINED, limit)),
      );
    },
  };
}

export class RemoteControlStore extends Context.Service<
  RemoteControlStore,
  Awaited<ReturnType<typeof createRemoteControlStore>>
>()("@t3tools/desktop/remoteControl/RemoteControlStore") {}
export const layer = Layer.effect(
  RemoteControlStore,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment;
    const windows = yield* ElectronWindow;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const publish = (channel: string, value: unknown) => {
      void run(windows.sendAll(channel, value)).catch(() => {});
    };
    const store = yield* Effect.promise(() =>
      createRemoteControlStore({
        stateDir: environment.stateDir,
        onGrantsChanged: (grants) =>
          publish(Channels.REMOTE_CONTROL_GRANTS_CHANGED_CHANNEL, grants),
        onPendingChanged: (pending) =>
          publish(Channels.REMOTE_CONTROL_PENDING_CHANGED_CHANNEL, pending),
        onAttention: () => {
          void run(
            Effect.gen(function* () {
              const main = yield* windows.main;
              if (Option.isNone(main)) return;
              yield* windows.reveal(main.value);
              if (environment.platform === "win32" && !main.value.isDestroyed()) {
                main.value.flashFrame(true);
                main.value.once("focus", () => {
                  if (!main.value.isDestroyed()) main.value.flashFrame(false);
                });
                if (main.value.isFocused()) main.value.flashFrame(false);
              }
            }),
          ).catch(() => {});
        },
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => store.rejectEnvironment()));
    return store;
  }),
);
