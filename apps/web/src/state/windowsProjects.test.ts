import {
  EnvironmentId,
  ProjectId,
  type DesktopLinkedFolder,
  type DesktopLinkedProject,
  type LinkedSyncStatus,
  type LinkedProjectsBridge,
} from "@t3tools/contracts";
import { act, createElement, Fragment, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  canCreateWindowsProject,
  createWindowsProject,
  unlinkWindowsProject,
  resolveWindowsConflict,
  setWindowsProjectHostConnected,
  useLinkedProjects,
  useCanCreateWindowsProject,
  useWindowsProjectInfo,
} from "./windowsProjects";
const state = vi.hoisted(() => ({
  server: undefined as unknown,
  bridge: null as LinkedProjectsBridge | null,
  target: { _tag: "BearerConnectionTarget", connectionId: "remote" },
  platform: "win32",
  rpc: vi.fn(),
  refresh: vi.fn(),
  query: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.server }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  createEnvironmentRpcCommand: (_runtime: unknown, options: unknown) => options,
  createEnvironmentRpcQueryAtomFamily: () => (target: unknown) => {
    state.query(target);
    return {};
  },
  runAtomCommand: (...args: unknown[]) => state.rpc(...args),
  squashAtomCommandFailure: (failure: unknown) => failure,
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../connection/catalog", () => ({ environmentCatalog: { catalogValueAtom: {} } }));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => ({ entries: new Map([["env", { target: state.target }]]) }),
    refresh: () => state.refresh(),
  },
}));
vi.mock("../env", () => ({ isElectron: true }));
vi.mock("../components/remoteControl/useRemoteControl", () => ({
  readLinkedProjectsBridge: () => state.bridge,
  readRemoteControlBridge: () => ({ getHostIdentity: async () => ({ hostId: "host" }) }),
}));
const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const link: DesktopLinkedProject = {
  projectId,
  hostId: "host",
  hostName: "host",
  serverPath: "/work",
  winPath: "C:\\work",
  createdAt: "2026-11-14T00:00:00Z",
};
const local: DesktopLinkedFolder = {
  ...link,
  environmentId,
  id: "id",
  syncSession: "session",
  paused: false,
};
const synced: LinkedSyncStatus = { linkId: local.id, state: "synced", conflicts: [] };
let onChanged: (records: readonly DesktopLinkedFolder[]) => void;
let onStatus: (statuses: readonly LinkedSyncStatus[]) => void;
let renderer: ReactTestRenderer | undefined;
let latest: ReturnType<typeof useLinkedProjects>;
let info: ReturnType<typeof useWindowsProjectInfo>;
const offLocal = vi.fn();
const offStatus = vi.fn();
function Probe() {
  const projects = useLinkedProjects(environmentId);
  const projectInfo = useWindowsProjectInfo(environmentId, projectId);
  useLayoutEffect(() => {
    latest = projects;
    info = projectInfo;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { desktopBridge: { getClientPlatform: () => state.platform } });
  state.platform = "win32";
  state.target = { _tag: "BearerConnectionTarget", connectionId: "remote" };
  state.server = AsyncResult.success({ links: [link] });
  state.bridge = {
    list: vi.fn(async () => [local]),
    getStatuses: vi.fn(async () => [synced]),
    onChanged: vi.fn((listener) => {
      onChanged = listener;
      return offLocal;
    }),
    onStatusChanged: vi.fn((listener) => {
      onStatus = listener;
      return offStatus;
    }),
    pickFolder: vi.fn(async () => link.winPath),
    register: vi.fn(async () => local),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    resolveConflict: vi.fn(async () => {}),
  };
  state.rpc.mockReset().mockResolvedValue({ _tag: "Success", value: { ...link, created: true } });
  state.refresh.mockClear();
  state.query.mockClear();
  offLocal.mockClear();
  offStatus.mockClear();
  setWindowsProjectHostConnected(environmentId, true);
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  setWindowsProjectHostConnected(environmentId, false);
  vi.unstubAllGlobals();
});
it("uses channel lifecycle and remote target classification for eligibility", () => {
  expect(canCreateWindowsProject(environmentId)).toBe(true);
  setWindowsProjectHostConnected(environmentId, false);
  expect(canCreateWindowsProject(environmentId)).toBe(false);
  setWindowsProjectHostConnected(environmentId, true);
  state.target.connectionId = "local:wsl:Ubuntu";
  expect(canCreateWindowsProject(environmentId)).toBe(false);
  state.target = { _tag: "PrimaryConnectionTarget", connectionId: "" };
  expect(canCreateWindowsProject(environmentId)).toBe(false);
});
it("routes exported commands through environment RPC and bridge", async () => {
  expect(await createWindowsProject({ environmentId })).toEqual({ projectId, created: true });
  expect(state.rpc).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ tag: "desktopLink.createProject" }),
    { environmentId, input: { hostId: "host", winPath: link.winPath } },
  );
  expect(state.refresh).toHaveBeenCalled();
  await resolveWindowsConflict({ environmentId, projectId, path: "a.txt", keep: "windows" });
  expect(state.bridge?.flush).toHaveBeenCalledWith(local.id);
  await unlinkWindowsProject({ environmentId, projectId, deleteServerCopy: false });
  expect(state.bridge?.remove).toHaveBeenCalledWith(local.id);
});
it("both hooks merge server, desktop records and status, follow pushes, and unsubscribe", async () => {
  await act(() => {
    renderer = create(createElement(Probe));
  });
  expect(state.bridge?.onChanged).toHaveBeenCalledTimes(1);
  expect(state.bridge?.onStatusChanged).toHaveBeenCalledTimes(1);
  expect(state.bridge?.list).toHaveBeenCalledTimes(1);
  expect(state.bridge?.getStatuses).toHaveBeenCalledTimes(1);
  expect(latest.projects.get(projectId)).toEqual({ link, local, status: synced });
  expect(info).toEqual({ link, local, status: synced });
  await act(() => {
    onStatus([{ ...synced, state: "conflicts", conflicts: [{ path: "a.txt" }] }]);
  });
  expect(info?.status?.conflicts[0]?.path).toBe("a.txt");
  await act(() => {
    onChanged([]);
  });
  expect(info).toEqual({ link });
  await act(() => renderer?.unmount());
  renderer = undefined;
  expect(offLocal).toHaveBeenCalledTimes(1);
  expect(offStatus).toHaveBeenCalledTimes(1);
});
it("server-only clients see server links without desktop records", async () => {
  state.bridge = null;
  await act(() => {
    renderer = create(createElement(Probe));
  });
  expect(info).toEqual({ link });
});
it("push updates win over initial reads that settle later", async () => {
  let settle!: (records: DesktopLinkedFolder[]) => void;
  vi.mocked(state.bridge!.list).mockReturnValue(
    new Promise((resolve) => {
      settle = resolve;
    }),
  );
  await act(() => {
    renderer = create(createElement(Probe));
  });
  await act(async () => {
    onChanged([{ ...local, paused: true }]);
    settle([local]);
  });
  expect(info?.local?.paused).toBe(true);
});

let canCreate = false;
let canCreateCommits = 0;
function AvailabilityProbe({ environment }: { environment: EnvironmentId | null }) {
  const available = useCanCreateWindowsProject(environment);
  useLayoutEffect(() => {
    canCreate = available;
    canCreateCommits++;
  });
  return null;
}
function InfoProbe({
  environment,
  project = projectId,
}: {
  environment: EnvironmentId | null;
  project?: ProjectId | null;
}) {
  const projectInfo = useWindowsProjectInfo(environment, project);
  useLayoutEffect(() => {
    info = projectInfo;
  });
  return null;
}
function ListProbe() {
  const projects = useLinkedProjects(environmentId);
  useLayoutEffect(() => {
    latest = projects;
  });
  return null;
}
function Readers({ list }: { list: boolean }) {
  return createElement(
    Fragment,
    null,
    list ? createElement(ListProbe, { key: "list" }) : null,
    createElement(InfoProbe, { key: "info", environment: environmentId }),
  );
}
it("availability reacts to connect/disconnect, ignores repeated values, and supports null", async () => {
  setWindowsProjectHostConnected(environmentId, false);
  canCreateCommits = 0;
  await act(() => {
    renderer = create(createElement(AvailabilityProbe, { environment: environmentId }));
  });
  expect(canCreate).toBe(false);
  await act(() => {
    setWindowsProjectHostConnected(environmentId, true);
  });
  expect(canCreate).toBe(true);
  const commits = canCreateCommits;
  await act(() => {
    setWindowsProjectHostConnected(environmentId, true);
    setWindowsProjectHostConnected(EnvironmentId.make("other"), true);
  });
  expect(canCreateCommits).toBe(commits);
  await act(() => {
    setWindowsProjectHostConnected(environmentId, false);
  });
  expect(canCreate).toBe(false);
  await act(() => {
    renderer?.update(createElement(AvailabilityProbe, { environment: null }));
  });
  expect(canCreate).toBe(false);
  setWindowsProjectHostConnected(EnvironmentId.make("other"), false);
});
it("keeps one shared bridge subscription until the last subscriber unmounts", async () => {
  await act(() => {
    renderer = create(createElement(Readers, { list: true }));
  });
  expect(state.bridge?.onChanged).toHaveBeenCalledTimes(1);
  expect(state.bridge?.onStatusChanged).toHaveBeenCalledTimes(1);
  expect(state.bridge?.list).toHaveBeenCalledTimes(1);
  expect(state.bridge?.getStatuses).toHaveBeenCalledTimes(1);
  await act(() => {
    renderer?.update(createElement(Readers, { list: false }));
  });
  expect(offLocal).not.toHaveBeenCalled();
  expect(offStatus).not.toHaveBeenCalled();
  await act(() => {
    onChanged([{ ...local, paused: true }]);
  });
  expect(info?.local?.paused).toBe(true);
  await act(() => renderer?.unmount());
  renderer = undefined;
  expect(offLocal).toHaveBeenCalledTimes(1);
  expect(offStatus).toHaveBeenCalledTimes(1);
});
it("null project environments perform neither server queries nor bridge reads/subscriptions", async () => {
  await act(() => {
    renderer = create(createElement(InfoProbe, { environment: null }));
  });
  expect(info).toBeNull();
  expect(state.query).not.toHaveBeenCalled();
  expect(state.rpc).not.toHaveBeenCalled();
  expect(state.bridge?.list).not.toHaveBeenCalled();
  expect(state.bridge?.getStatuses).not.toHaveBeenCalled();
  expect(state.bridge?.onChanged).not.toHaveBeenCalled();
  expect(state.bridge?.onStatusChanged).not.toHaveBeenCalled();
  await act(() => {
    renderer?.update(createElement(InfoProbe, { environment: environmentId }));
  });
  expect(info?.local).toEqual(local);
  await act(() => {
    renderer?.update(createElement(InfoProbe, { environment: null }));
  });
  expect(info).toBeNull();
  expect(offLocal).toHaveBeenCalledTimes(1);
});
it("ignores late responses from a previous subscription after unmount and remount", async () => {
  let settle!: (records: DesktopLinkedFolder[]) => void;
  vi.mocked(state.bridge!.list)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        settle = resolve;
      }),
    )
    .mockResolvedValue([{ ...local, paused: true }]);
  await act(() => {
    renderer = create(createElement(InfoProbe, { environment: environmentId }));
  });
  await act(() => renderer?.unmount());
  await act(() => {
    renderer = create(createElement(InfoProbe, { environment: environmentId }));
  });
  expect(info?.local?.paused).toBe(true);
  await act(() => {
    settle([local]);
  });
  expect(info?.local?.paused).toBe(true);
  expect(state.bridge?.list).toHaveBeenCalledTimes(2);
});

it("a missing project also returns null without starting queries or local subscriptions", async () => {
  await act(() => {
    renderer = create(createElement(InfoProbe, { environment: environmentId, project: null }));
  });
  expect(info).toBeNull();
  expect(state.query).not.toHaveBeenCalled();
  expect(state.bridge?.list).not.toHaveBeenCalled();
  expect(state.bridge?.onChanged).not.toHaveBeenCalled();
});
it("shares initial-read errors between subscribers", async () => {
  const error = new Error("bridge read failed");
  vi.mocked(state.bridge!.list).mockRejectedValueOnce(error);
  await act(() => {
    renderer = create(createElement(Probe));
  });
  expect(latest.error).toBe(error);
  expect(state.bridge?.list).toHaveBeenCalledTimes(1);
});
