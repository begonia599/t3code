// @effect-diagnostics nodeBuiltinImport:off -- Tests own temporary native folders.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import {
  EnvironmentId,
  ProjectId,
  type DesktopLinkedFolder,
  type DesktopLinkedProject,
} from "@t3tools/contracts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createLinkedProjects } from "./LinkedProjects.ts";
import { createLinkedSync } from "./LinkedSync.ts";
import { removeWindowsConflict } from "./linkedConflict.ts";
import { DEFAULT_DESKTOP_SETTINGS } from "../settings/DesktopAppSettings.ts";
const link: DesktopLinkedProject = {
  projectId: ProjectId.make("project"),
  hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
  hostName: "host",
  serverPath: "/work",
  winPath: "C:\\work",
  createdAt: "2026-11-14T00:00:00.000Z",
};
const input = { environmentId: EnvironmentId.make("env"), link };
function fixture() {
  let records: readonly DesktopLinkedFolder[] = [];
  const sessions = new Map<string, object>();
  const runner = vi.fn(async (_exe: string, args: readonly string[]) => {
    if (args[1] === "list") return JSON.stringify([...sessions.values()]);
    if (args[1] === "create") {
      const id = args.find((arg) => arg.startsWith("--label="))!.split("=")[2]!;
      sessions.set(id, {
        identifier: id,
        labels: { "t3-link": id },
        name: args.find((arg) => arg.startsWith("--name="))!.slice(7),
      });
    }
    if (args[1] === "terminate") sessions.delete(args[2]!);
    return "";
  });
  const sync = createLinkedSync({
    environment: async () => ({
      T3_MUTAGEN_EXE: "/private/mutagen",
      T3_MUTAGEN_DATA_DIRECTORY: "/private/data",
    }),
    runner,
  });
  const changed = vi.fn();
  const statusChanged = vi.fn();
  const service = createLinkedProjects({
    getConfig: async () => ({
      ...DEFAULT_DESKTOP_SETTINGS.remoteControl,
      hostId: link.hostId,
      linkedProjects: records,
    }),
    setRecords: async (next) => {
      records = next;
    },
    sync,
    onChanged: changed,
    onStatusChanged: statusChanged,
  });
  return { service, sync, runner, changed, statusChanged };
}
it("register is idempotent, serializes concurrent duplicates, and repairs a missing session", async () => {
  const { service, runner, sync } = fixture();
  const [first, second] = await Promise.all([service.register(input), service.register(input)]);
  expect(first).toEqual(second);
  expect(await service.list()).toHaveLength(1);
  expect(runner.mock.calls.filter((call) => call[1][1] === "create")).toHaveLength(1);
  await sync.terminate(first);
  expect(await service.register(input)).toEqual(first);
  expect(runner.mock.calls.filter((call) => call[1][1] === "create")).toHaveLength(2);
  await expect(service.register({ ...input, link: { ...link, hostId: "other" } })).rejects.toThrow(
    "another desktop",
  );
  await expect(
    service.register({
      ...input,
      link: { ...link, projectId: ProjectId.make("other"), winPath: "c:\\WORK" },
    }),
  ).rejects.toThrow("Duplicate");
});
it("rolls back failed session creation and emits no record-added event", async () => {
  const { service, sync, changed } = fixture();
  vi.spyOn(sync, "create").mockRejectedValue(new Error("bad daemon"));
  await expect(service.register(input)).rejects.toThrow("bad daemon");
  expect(await service.list()).toEqual([]);
  expect(changed).not.toHaveBeenCalled();
});
let root: string | undefined;
afterEach(async () => {
  if (root) await NodeFSP.rm(root, { recursive: true, force: true });
  root = undefined;
});
it("remove terminates the session but preserves files; pause and resume persist", async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "linked-remove-"));
  const file = NodePath.join(root, "keep");
  await NodeFSP.writeFile(file, "keep");
  const { service, runner } = fixture();
  const record = await service.register(input);
  await service.pause(record.id);
  expect((await service.list())[0]?.paused).toBe(true);
  await service.resume(record.id);
  expect((await service.list())[0]?.paused).toBe(false);
  await service.remove(record.id);
  await service.remove(record.id);
  expect(await service.list()).toEqual([]);
  expect(runner.mock.calls.some((call) => call[1][1] === "terminate")).toBe(true);
  expect(await NodeFSP.readFile(file, "utf8")).toBe("keep");
});
it("conflict deletion rejects traversal and canonical parent escapes, unlinks symlinks, accepts missing targets", async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "linked-conflict-"));
  const folder = NodePath.join(root, "folder");
  const outside = NodePath.join(root, "outside");
  await NodeFSP.mkdir(folder);
  await NodeFSP.mkdir(outside);
  await NodeFSP.writeFile(NodePath.join(outside, "a"), "outside");
  for (const path of [
    "/a",
    "C:a",
    "C:\\a",
    "\\\\host\\share",
    "../a",
    "a/../b",
    ".git/HEAD",
    ".GIT/config",
    "a:stream",
  ])
    await expect(removeWindowsConflict(folder, path)).rejects.toThrow();
  await NodeFSP.symlink(outside, NodePath.join(folder, "escape"));
  await expect(removeWindowsConflict(folder, "escape/a")).rejects.toThrow("escapes");
  await NodeFSP.symlink(NodePath.join(outside, "a"), NodePath.join(folder, "a"));
  await removeWindowsConflict(folder, "a");
  expect(await NodeFSP.readFile(NodePath.join(outside, "a"), "utf8")).toBe("outside");
  await NodeFSP.mkdir(NodePath.join(folder, "directory-conflict"));
  await NodeFSP.writeFile(NodePath.join(folder, "directory-conflict", "child"), "discard");
  await NodeFSP.symlink(outside, NodePath.join(folder, "directory-conflict", "symlink"));
  await removeWindowsConflict(folder, "directory-conflict");
  expect(await NodeFSP.readFile(NodePath.join(outside, "a"), "utf8")).toBe("outside");
  await removeWindowsConflict(folder, "missing/a");
  await NodeFSP.writeFile(NodePath.join(folder, "conflict"), "remove");
  await removeWindowsConflict(folder, "conflict");
  expect(await NodeFSP.readdir(folder)).toEqual(["escape"]);
});

it("publishes only status changes and polls at two seconds visible and ten seconds hidden", async () => {
  vi.useFakeTimers();
  const { sync } = fixture();
  const refresh = vi.spyOn(sync, "refresh").mockResolvedValue([]);
  const onStatusChanged = vi.fn();
  let visible = true;
  const service = createLinkedProjects({
    getConfig: async () => ({ ...DEFAULT_DESKTOP_SETTINGS.remoteControl }),
    setRecords: async () => {},
    sync,
    onStatusChanged,
    visible: async () => visible,
  });
  try {
    expect(refresh).not.toHaveBeenCalled();
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    visible = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(9999);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(onStatusChanged).toHaveBeenCalledTimes(1);
    await service.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally {
    await service.stop();
    vi.useRealTimers();
  }
});
