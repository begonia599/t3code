import { EnvironmentId, ProjectId, type DesktopLinkedFolder } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  createLinkedSync,
  linkedSyncStatus,
  parseLinkedSessions,
  LINKED_SYNC_IGNORES,
} from "./LinkedSync.ts";
import { syncHost } from "./protocol.ts";
const record: DesktopLinkedFolder = {
  id: "91d581f4-d87a-4efe-967c-2b60314575bb",
  environmentId: EnvironmentId.make("env"),
  projectId: ProjectId.make("project"),
  hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
  serverPath: "/work",
  winPath: "C:\\work",
  syncSession: "t3-link-91d581f4",
  paused: false,
  createdAt: "2026-11-14T00:00:00.000Z",
};
const session = {
  identifier: "sync_id",
  name: record.syncSession,
  labels: { "t3-link": record.id },
  status: "watching",
  successfulCycles: 1,
  alpha: { connected: true },
  beta: { connected: true },
};
const environment = async () => ({
  T3_MUTAGEN_EXE: "/private/mutagen",
  T3_MUTAGEN_DATA_DIRECTORY: "/private/data",
});
it("creates all ignores and endpoints and runs lifecycle commands on the private daemon", async () => {
  const runner = vi.fn(async (_exe: string, args: readonly string[]) =>
    args[1] === "list" ? JSON.stringify([session]) : "",
  );
  const sync = createLinkedSync({ environment, runner });
  await sync.create(record);
  await sync.pause(record);
  await sync.resume(record);
  await sync.flush(record);
  await sync.terminate(record);
  expect(runner.mock.calls[0]?.[1]).toEqual([
    "sync",
    "create",
    `--name=${record.syncSession}`,
    `--label=t3-link=${record.id}`,
    "--sync-mode=two-way-safe",
    "--no-global-configuration",
    "--ignore-vcs",
    ...LINKED_SYNC_IGNORES.map((pattern) => `--ignore=${pattern}`),
    record.winPath,
    `${syncHost("env")}:${record.serverPath}`,
  ]);
  expect(runner).toHaveBeenCalledWith(
    "/private/mutagen",
    ["sync", "flush", record.syncSession],
    expect.objectContaining({
      MUTAGEN_DATA_DIRECTORY: "/private/data",
      MUTAGEN_DISABLE_AUTOSTART: "1",
    }),
  );
  runner.mockClear();
  await sync.flush({ ...record, paused: true });
  expect(runner).not.toHaveBeenCalled();
});
it("reconciles missing unpaused sessions and terminates orphans even with no local records", async () => {
  const orphan = { ...session, identifier: "orphan", labels: { "t3-link": "removed" } };
  const runner = vi.fn(async (_exe: string, args: readonly string[]) =>
    args[1] === "list" ? JSON.stringify([orphan]) : "",
  );
  const sync = createLinkedSync({ environment, privateEnvironment: environment, runner });
  await sync.refresh([record, { ...record, id: "paused", paused: true }], true);
  expect(runner).toHaveBeenCalledWith(
    "/private/mutagen",
    ["sync", "terminate", "orphan"],
    expect.anything(),
  );
  expect(runner.mock.calls.filter((call) => call[1][1] === "create")).toHaveLength(1);
  runner.mockClear();
  await sync.refresh([], true);
  expect(runner).toHaveBeenCalledWith(
    "/private/mutagen",
    ["sync", "terminate", "orphan"],
    expect.anything(),
  );
});
it("reports sync unavailability without invoking a PATH binary", async () => {
  const runner = vi.fn();
  const sync = createLinkedSync({ environment: async () => ({}), runner });
  await expect(sync.create(record)).rejects.toThrow("unavailable");
  expect(await sync.refresh([record])).toMatchObject([
    { state: "error", message: expect.stringContaining("unavailable") },
  ]);
  expect(runner).not.toHaveBeenCalled();
});
it.each([
  [{ successfulCycles: 0 }, "initial"],
  [{}, "synced"],
  [{ status: "scanning" }, "syncing"],
  [{ status: "staging-alpha" }, "syncing"],
  [{ status: "transitioning" }, "syncing"],
  [
    {
      conflicts: [
        { root: "a.txt", alphaChanges: [{ path: "a.txt" }], betaChanges: [{ path: "a.txt" }] },
      ],
    },
    "conflicts",
  ],
  [{ beta: { connected: false } }, "disconnected"],
  [{ paused: true }, "paused"],
  [{ status: "halted-on-root-emptying" }, "error"],
  [{ lastError: "disk full" }, "error"],
] as const)("parses Mutagen state %j as %s", (patch, state) => {
  const parsed = parseLinkedSessions(JSON.stringify([{ ...session, ...patch }]))[0]!;
  const result = linkedSyncStatus(record, parsed, undefined, () => "now");
  expect(result.state).toBe(state);
  if (state === "conflicts") expect(result.conflicts[0]?.path).toBe("a.txt");
  if (state === "error") expect(result.message).toBeTruthy();
  if (state === "synced")
    expect(linkedSyncStatus(record, parsed, result, () => "later").lastSyncedAt).toBe("now");
});
