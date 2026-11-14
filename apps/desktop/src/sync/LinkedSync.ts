// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Private native CLI boundary owns bounded processes, polling and observation timestamps.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import type { DesktopLinkedFolder, LinkedSyncStatus } from "@t3tools/contracts";
import { syncHost } from "./protocol.ts";

export const LINKED_SYNC_IGNORES = [
  "node_modules/",
  "Library/",
  "Temp/",
  "Logs/",
  "obj/",
  "bin/",
  "UserSettings/",
  "Build*/",
  ".vs/",
  "*.csproj",
  "*.sln",
] as const;

export type MutagenRunner = (
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<string>;
export const runMutagen: MutagenRunner = (executable, args, env) =>
  new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      executable,
      [...args],
      { env, windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`Desktop Mutagen: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      },
    );
  });
const Change = Schema.Struct({ path: Schema.String });
const Session = Schema.Struct({
  identifier: Schema.String,
  name: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  paused: Schema.optionalKey(Schema.Boolean),
  status: Schema.optionalKey(Schema.String),
  successfulCycles: Schema.optionalKey(Schema.Number),
  lastError: Schema.optionalKey(Schema.String),
  alpha: Schema.optionalKey(Schema.Struct({ connected: Schema.optionalKey(Schema.Boolean) })),
  beta: Schema.optionalKey(Schema.Struct({ connected: Schema.optionalKey(Schema.Boolean) })),
  conflicts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        root: Schema.optionalKey(Schema.String),
        alphaChanges: Schema.optionalKey(Schema.Array(Change)),
        betaChanges: Schema.optionalKey(Schema.Array(Change)),
      }),
    ),
  ),
});
export const parseLinkedSessions = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(Session)),
);
type Session = typeof Session.Type;

export function linkedSyncStatus(
  record: DesktopLinkedFolder,
  session?: Session,
  previous?: LinkedSyncStatus,
  now = () => new Date().toISOString(),
): LinkedSyncStatus {
  const conflicts = (session?.conflicts ?? []).map((conflict) => ({
    path:
      conflict.root ?? conflict.alphaChanges?.[0]?.path ?? conflict.betaChanges?.[0]?.path ?? "",
    alpha: conflict.alphaChanges,
    beta: conflict.betaChanges,
  }));
  const status = session?.status ?? "";
  const state: LinkedSyncStatus["state"] =
    record.paused || session?.paused
      ? "paused"
      : !session
        ? "initial"
        : session.lastError || status.startsWith("halted")
          ? "error"
          : !session.beta?.connected || !session.alpha?.connected
            ? "disconnected"
            : conflicts.length
              ? "conflicts"
              : !(session.successfulCycles && session.successfulCycles > 0) &&
                  !previous?.lastSyncedAt
                ? "initial"
                : status === "watching"
                  ? "synced"
                  : "syncing";
  const lastSyncedAt =
    state === "synced" && previous?.state !== "synced" ? now() : previous?.lastSyncedAt;
  return {
    linkId: record.id,
    state,
    conflicts,
    ...(state === "error" ? { message: session?.lastError || status } : {}),
    ...(lastSyncedAt ? { lastSyncedAt } : {}),
  };
}

export function createLinkedSync(options: {
  environment: (environmentId: string) => Promise<Readonly<Record<string, string>>>;
  runner?: MutagenRunner;
  privateEnvironment?: () => Promise<Readonly<Record<string, string>>>;
}) {
  const runner = options.runner ?? runMutagen;
  const cli = async (environmentId: string, args: readonly string[]) => {
    const env =
      environmentId === "" && options.privateEnvironment
        ? await options.privateEnvironment()
        : await options.environment(environmentId);
    if (!env.T3_MUTAGEN_EXE || !env.T3_MUTAGEN_DATA_DIRECTORY)
      throw new Error(
        "Desktop private Mutagen is unavailable (binary, daemon or environment connection missing)",
      );
    return runner(env.T3_MUTAGEN_EXE, args, {
      ...process.env,
      MUTAGEN_DATA_DIRECTORY: env.T3_MUTAGEN_DATA_DIRECTORY,
      MUTAGEN_DISABLE_AUTOSTART: "1",
    });
  };
  const sessions = async (environmentId: string) =>
    parseLinkedSessions(
      await cli(environmentId, [
        "sync",
        "list",
        "--label-selector=t3-link",
        "--template={{json .}}",
      ]),
    );
  const command = async (record: DesktopLinkedFolder, action: string) => {
    await cli(record.environmentId, ["sync", action, record.syncSession]);
  };
  const create = async (record: DesktopLinkedFolder) => {
    await cli(record.environmentId, [
      "sync",
      "create",
      `--name=${record.syncSession}`,
      `--label=t3-link=${record.id}`,
      "--sync-mode=two-way-safe",
      "--no-global-configuration",
      "--ignore-vcs",
      ...LINKED_SYNC_IGNORES.map((pattern) => `--ignore=${pattern}`),
      record.winPath,
      `${syncHost(record.environmentId)}:${record.serverPath}`,
    ]);
  };
  const ensure = async (record: DesktopLinkedFolder) => {
    const existing = (await sessions(record.environmentId)).find(
      (session) => session.labels?.["t3-link"] === record.id && session.name === record.syncSession,
    );
    if (!existing) {
      await create(record);
      if (record.paused) await command(record, "pause");
    } else if (Boolean(existing.paused) !== record.paused)
      await command(record, record.paused ? "pause" : "resume");
  };
  let statuses: LinkedSyncStatus[] = [];
  const refresh = async (
    records: readonly DesktopLinkedFolder[],
    reconcile = false,
  ): Promise<LinkedSyncStatus[]> => {
    const next: LinkedSyncStatus[] = [];
    if (!records.length && !options.privateEnvironment) {
      statuses = [];
      return statuses;
    }
    let listed: readonly Session[];
    try {
      listed = await sessions(options.privateEnvironment ? "" : records[0]!.environmentId);
      if (reconcile)
        for (const session of listed)
          if (!records.some((record) => record.id === session.labels?.["t3-link"]))
            await cli(options.privateEnvironment ? "" : records[0]!.environmentId, [
              "sync",
              "terminate",
              session.identifier,
            ]);
    } catch (error) {
      statuses = records.map((record) => ({
        linkId: record.id,
        state: "error",
        conflicts: [],
        message: String(error),
      }));
      return statuses;
    }
    for (const record of records) {
      try {
        const env = await options.environment(record.environmentId);
        if (!env.T3_MUTAGEN_EXE || !env.T3_MUTAGEN_DATA_DIRECTORY)
          throw new Error("Desktop private Mutagen is unavailable for this environment");
        const session = listed.find((session) => session.labels?.["t3-link"] === record.id);
        if (reconcile) {
          if (!session && !record.paused) await create(record);
          else if (session && Boolean(session.paused) !== record.paused)
            await command(record, record.paused ? "pause" : "resume");
        }
        next.push(
          linkedSyncStatus(
            record,
            session,
            statuses.find((status) => status.linkId === record.id),
          ),
        );
      } catch (error) {
        next.push({ linkId: record.id, state: "error", conflicts: [], message: String(error) });
      }
    }
    statuses = next;
    return statuses;
  };
  return {
    create,
    ensure,
    refresh,
    sessions,
    getStatuses: () => statuses,
    pause: (record: DesktopLinkedFolder) => command(record, "pause"),
    resume: (record: DesktopLinkedFolder) => command(record, "resume"),
    terminate: async (record: DesktopLinkedFolder) => {
      const existing = (await sessions(record.environmentId)).find(
        (session) => session.labels?.["t3-link"] === record.id,
      );
      if (existing) await cli(record.environmentId, ["sync", "terminate", existing.identifier]);
    },
    flush: (record: DesktopLinkedFolder) =>
      record.paused ? Promise.resolve() : command(record, "flush"),
  };
}
