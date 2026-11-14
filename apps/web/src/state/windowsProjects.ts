import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  WS_METHODS,
  type EnvironmentId,
  type DesktopLinkedFolder,
  type DesktopLinkedProject,
  type LinkedSyncStatus,
  type ProjectId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo, useSyncExternalStore } from "react";
import {
  readLinkedProjectsBridge,
  readRemoteControlBridge,
} from "../components/remoteControl/useRemoteControl";
import { isElectron } from "../env";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  createWindowsProjects,
  mergeWindowsProjects,
  type WindowsProjectInfo,
} from "./windowsProjects.logic";

const linksQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "windows-projects:list",
  tag: WS_METHODS.desktopLinkList,
  staleTimeMs: 2000,
  refreshIntervalMs: 10000,
});
const createCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "windows-projects:create",
  tag: WS_METHODS.desktopLinkCreateProject,
});
const unlinkCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "windows-projects:unlink",
  tag: WS_METHODS.desktopLinkUnlink,
});
const conflictCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "windows-projects:conflict",
  tag: WS_METHODS.desktopLinkResolveConflict,
});
const unwrap = async <A, E>(
  result: Promise<import("@t3tools/client-runtime/state/runtime").AtomCommandResult<A, E>>,
) => {
  const settled = await result;
  if (settled._tag === "Failure") throw squashAtomCommandFailure(settled);
  return settled.value;
};

const connectedEnvironments = (() => {
  let snapshot: ReadonlySet<EnvironmentId> = new Set();
  const listeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    set(environmentId: EnvironmentId, connected: boolean) {
      if (snapshot.has(environmentId) === connected) return;
      const next = new Set(snapshot);
      if (connected) next.add(environmentId);
      else next.delete(environmentId);
      snapshot = next;
      for (const listener of listeners) listener();
    },
  };
})();
/** Called by the owner of the DesktopChannel connect stream, never inferred from the enable switch. */
export function setWindowsProjectHostConnected(environmentId: EnvironmentId, connected: boolean) {
  connectedEnvironments.set(environmentId, connected);
}
const logic = createWindowsProjects({
  desktop: () => isElectron,
  platform: () =>
    typeof window !== "undefined" ? window.desktopBridge?.getClientPlatform?.() : undefined,
  bridge: readLinkedProjectsBridge,
  remoteControl: readRemoteControlBridge,
  remote: (environmentId) => {
    const entry = appAtomRegistry
      .get(environmentCatalog.catalogValueAtom)
      .entries.get(environmentId);
    return (
      entry !== undefined &&
      entry.target._tag !== "PrimaryConnectionTarget" &&
      !isDesktopLocalConnectionTarget(entry.target)
    );
  },
  connected: (environmentId) => connectedEnvironments.getSnapshot().has(environmentId),
  rpc: {
    create: (environmentId, input) =>
      unwrap(runAtomCommand(appAtomRegistry, createCommand, { environmentId, input })),
    unlink: (environmentId, input) =>
      unwrap(runAtomCommand(appAtomRegistry, unlinkCommand, { environmentId, input })),
    resolveConflict: (environmentId, input) =>
      unwrap(runAtomCommand(appAtomRegistry, conflictCommand, { environmentId, input })),
  },
  changed: (environmentId) => appAtomRegistry.refresh(linksQuery({ environmentId, input: {} })),
  log: (message, error) => console.error(message, error),
});
export const {
  canCreateWindowsProject,
  createWindowsProject,
  unlinkWindowsProject,
  resolveWindowsConflict,
} = logic;

export function useCanCreateWindowsProject(environmentId: EnvironmentId | null): boolean {
  return useSyncExternalStore(
    connectedEnvironments.subscribe,
    () => environmentId !== null && canCreateWindowsProject(environmentId),
    () => false,
  );
}

type LocalLinkedProjects = {
  readonly local: readonly DesktopLinkedFolder[];
  readonly statuses: readonly LinkedSyncStatus[];
  readonly error: unknown;
};
const EMPTY_LOCAL: LocalLinkedProjects = { local: [], statuses: [], error: null };
const emptyLocalSnapshot = () => EMPTY_LOCAL;
const noSubscription = () => () => {};
const localLinkedProjects = (() => {
  let snapshot = EMPTY_LOCAL;
  const listeners = new Set<() => void>();
  let stop = () => {};
  const update = (patch: Partial<LocalLinkedProjects>) => {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) listener();
  };
  const start = () => {
    const bridge = readLinkedProjectsBridge();
    if (!bridge) return () => {};
    let active = true;
    let localPushed = false;
    let statusPushed = false;
    const offLocal = bridge.onChanged((local) => {
      if (!active) return;
      localPushed = true;
      update({ local });
    });
    const offStatus = bridge.onStatusChanged((statuses) => {
      if (!active) return;
      statusPushed = true;
      update({ statuses });
    });
    const failed = (error: unknown) => {
      if (active) update({ error });
    };
    void bridge.list().then((local) => {
      if (active && !localPushed) update({ local });
    }, failed);
    void bridge.getStatuses().then((statuses) => {
      if (active && !statusPushed) update({ statuses });
    }, failed);
    return () => {
      active = false;
      offLocal();
      offStatus();
    };
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) stop = start();
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        stop();
        snapshot = EMPTY_LOCAL;
      };
    },
  };
})();
const EMPTY_SERVER_LINKS = Atom.make(
  AsyncResult.success({ links: [] as readonly DesktopLinkedProject[] }),
);
const EMPTY_PROJECTS: ReadonlyMap<ProjectId, WindowsProjectInfo> = new Map();
function useLinkedProjectsState(environmentId: EnvironmentId | null) {
  const server = useAtomValue(
    environmentId === null ? EMPTY_SERVER_LINKS : linksQuery({ environmentId, input: {} }),
  );
  const { local, statuses, error } = useSyncExternalStore(
    environmentId === null ? noSubscription : localLinkedProjects.subscribe,
    environmentId === null ? emptyLocalSnapshot : localLinkedProjects.getSnapshot,
    emptyLocalSnapshot,
  );
  const projects = useMemo(
    () =>
      environmentId === null
        ? EMPTY_PROJECTS
        : mergeWindowsProjects(
            environmentId,
            Option.getOrUndefined(AsyncResult.value(server))?.links ?? [],
            local,
            statuses,
          ),
    [environmentId, server, local, statuses],
  );
  return { projects, error: error ?? (server._tag === "Failure" ? server.cause : null) };
}
export function useLinkedProjects(environmentId: EnvironmentId) {
  return useLinkedProjectsState(environmentId);
}
export function useWindowsProjectInfo(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  const { projects } = useLinkedProjectsState(projectId === null ? null : environmentId);
  return projectId === null ? null : (projects.get(projectId) ?? null);
}
