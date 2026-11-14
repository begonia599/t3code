import {
  EnvironmentId,
  ProjectId,
  type DesktopLinkedFolder,
  type DesktopLinkedProject,
  type LinkedProjectsBridge,
  type LinkedSyncStatus,
  type RemoteControlBridge,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import {
  createWindowsProjects,
  mergeWindowsProjects,
  WindowsProjectError,
} from "./windowsProjects.logic";
const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const link: DesktopLinkedProject = {
  projectId,
  hostId: "host",
  hostName: "Windows",
  serverPath: "/work",
  winPath: "C:\\work",
  createdAt: "2026-11-14T00:00:00Z",
};
const local: DesktopLinkedFolder = {
  ...link,
  id: "local",
  environmentId,
  syncSession: "t3-link-local",
  paused: false,
};
function fixture() {
  const bridge: LinkedProjectsBridge = {
    pickFolder: vi.fn(async () => link.winPath),
    register: vi.fn(async () => local),
    list: vi.fn(async () => [local]),
    getStatuses: vi.fn(async () => []),
    onStatusChanged: vi.fn(() => () => {}),
    onChanged: vi.fn(() => () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    resolveConflict: vi.fn(async () => {}),
  };
  const rpc = {
    create: vi.fn(async () => ({ ...link, created: true })),
    unlink: vi.fn(async () => ({})),
    resolveConflict: vi.fn(async () => ({})),
  };
  const deps = {
    desktop: vi.fn(() => true),
    platform: vi.fn(() => "win32"),
    bridge: vi.fn((): LinkedProjectsBridge | null => bridge),
    remoteControl: () =>
      ({ getHostIdentity: async () => ({ hostId: "host" }) }) as RemoteControlBridge,
    remote: vi.fn(() => true),
    connected: vi.fn(() => true),
    rpc,
    changed: vi.fn(),
    log: vi.fn(),
  };
  return { bridge, rpc, deps, logic: createWindowsProjects(deps) };
}
it("requires Electron, Windows, a remote environment, the linked bridge and an actual channel connection", () => {
  const { deps, logic } = fixture();
  expect(logic.canCreateWindowsProject(environmentId)).toBe(true);
  deps.desktop.mockReturnValue(false);
  expect(logic.canCreateWindowsProject(environmentId)).toBe(false);
  deps.desktop.mockReturnValue(true);
  deps.platform.mockReturnValue("linux");
  expect(logic.canCreateWindowsProject(environmentId)).toBe(false);
  deps.platform.mockReturnValue("win32");
  deps.remote.mockReturnValue(false);
  expect(logic.canCreateWindowsProject(environmentId)).toBe(false);
  deps.remote.mockReturnValue(true);
  deps.connected.mockReturnValue(false);
  expect(logic.canCreateWindowsProject(environmentId)).toBe(false);
  deps.connected.mockReturnValue(true);
  deps.bridge.mockReturnValue(null);
  expect(logic.canCreateWindowsProject(environmentId)).toBe(false);
});
it("creates in picker/server/sync order and returns project id and created flag", async () => {
  const { bridge, rpc, logic } = fixture();
  expect(await logic.createWindowsProject({ environmentId })).toEqual({ projectId, created: true });
  expect(rpc.create).toHaveBeenCalledWith(environmentId, { hostId: "host", winPath: link.winPath });
  expect(bridge.register).toHaveBeenCalledWith({ environmentId, link: { ...link, created: true } });
  expect(vi.mocked(bridge.pickFolder).mock.invocationCallOrder[0]).toBeLessThan(
    rpc.create.mock.invocationCallOrder[0]!,
  );
  expect(rpc.create.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(bridge.register).mock.invocationCallOrder[0]!,
  );
});
it("cancelled picker has no server or sync side effects", async () => {
  const { logic, bridge, rpc } = fixture();
  vi.mocked(bridge.pickFolder).mockResolvedValue(null);
  expect(await logic.createWindowsProject({ environmentId })).toBeNull();
  expect(rpc.create).not.toHaveBeenCalled();
  expect(bridge.register).not.toHaveBeenCalled();
});
it.each(["picker", "server", "sync"] as const)(
  "reports %s failure and preserves server links on registration failure",
  async (stage) => {
    const { logic, bridge, rpc, deps } = fixture();
    const error = new Error("failure");
    if (stage === "picker") vi.mocked(bridge.pickFolder).mockRejectedValue(error);
    if (stage === "server") rpc.create.mockRejectedValue(error);
    if (stage === "sync") vi.mocked(bridge.register).mockRejectedValue(error);
    const operation = logic.createWindowsProject({ environmentId });
    await expect(operation).rejects.toMatchObject({ stage });
    if (stage === "sync") {
      await expect(operation).rejects.toBe(error);
      expect(deps.log).toHaveBeenCalledWith(expect.any(String), error);
    } else await expect(operation).rejects.toBeInstanceOf(WindowsProjectError);
    expect(rpc.unlink).not.toHaveBeenCalled();
  },
);
it("unlinks on server first, removes only this environment's record, and works outside desktop", async () => {
  const { logic, rpc, bridge, deps } = fixture();
  await logic.unlinkWindowsProject({ environmentId, projectId, deleteServerCopy: false });
  expect(rpc.unlink).toHaveBeenCalledWith(environmentId, { projectId, deleteServerCopy: false });
  expect(bridge.remove).toHaveBeenCalledWith("local");
  rpc.unlink.mockRejectedValueOnce(new Error("offline"));
  vi.mocked(bridge.remove).mockClear();
  await expect(
    logic.unlinkWindowsProject({ environmentId, projectId, deleteServerCopy: true }),
  ).rejects.toThrow("offline");
  expect(bridge.remove).not.toHaveBeenCalled();
  deps.bridge.mockReturnValue(null);
  await logic.unlinkWindowsProject({ environmentId, projectId, deleteServerCopy: true });
});
it("resolves keep-server locally and keep-windows on server before flushing", async () => {
  const { logic, rpc, bridge } = fixture();
  await logic.resolveWindowsConflict({ environmentId, projectId, path: "a.txt", keep: "server" });
  expect(bridge.resolveConflict).toHaveBeenCalledWith({
    id: "local",
    path: "a.txt",
    keep: "server",
  });
  expect(rpc.resolveConflict).not.toHaveBeenCalled();
  await logic.resolveWindowsConflict({ environmentId, projectId, path: "a.txt", keep: "windows" });
  expect(rpc.resolveConflict).toHaveBeenCalledWith(environmentId, { projectId, path: "a.txt" });
  expect(bridge.flush).toHaveBeenCalledWith("local");
  expect(rpc.resolveConflict.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(bridge.flush).mock.invocationCallOrder[0]!,
  );
  rpc.resolveConflict.mockRejectedValueOnce(new Error("failed"));
  vi.mocked(bridge.flush).mockClear();
  await expect(
    logic.resolveWindowsConflict({ environmentId, projectId, path: "a.txt", keep: "windows" }),
  ).rejects.toThrow("failed");
  expect(bridge.flush).not.toHaveBeenCalled();
});
it("merges server records with only this environment's local authority and sync status", () => {
  const status: LinkedSyncStatus = { linkId: local.id, state: "synced", conflicts: [] };
  expect(mergeWindowsProjects(environmentId, [link], [local], [status]).get(projectId)).toEqual({
    link,
    local,
    status,
  });
  expect(
    mergeWindowsProjects(EnvironmentId.make("other"), [link], [local], [status]).get(projectId),
  ).toEqual({ link });
  expect(mergeWindowsProjects(environmentId, [], [local], [status]).size).toBe(0);
});
