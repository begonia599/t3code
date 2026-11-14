import type {
  DesktopLinkedFolder,
  DesktopLinkedProject,
  EnvironmentId,
  LinkedProjectsBridge,
  LinkedSyncStatus,
  ProjectId,
  RemoteControlBridge,
} from "@t3tools/contracts";

export interface WindowsProjectInfo {
  readonly link: DesktopLinkedProject;
  readonly local?: DesktopLinkedFolder;
  readonly status?: LinkedSyncStatus;
}
export function mergeWindowsProjects(
  environmentId: EnvironmentId,
  links: readonly DesktopLinkedProject[],
  local: readonly DesktopLinkedFolder[],
  statuses: readonly LinkedSyncStatus[],
): ReadonlyMap<ProjectId, WindowsProjectInfo> {
  return new Map(
    links.map((link) => {
      const record = local.find(
        (record) => record.environmentId === environmentId && record.projectId === link.projectId,
      );
      const status = record && statuses.find((status) => status.linkId === record.id);
      return [
        link.projectId,
        { link, ...(record ? { local: record } : {}), ...(status ? { status } : {}) },
      ];
    }),
  );
}
export class WindowsProjectError extends Error {
  readonly stage: "picker" | "server" | "sync";
  constructor(stage: WindowsProjectError["stage"], cause: unknown) {
    super(`${stage}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "WindowsProjectError";
    this.stage = stage;
  }
}
export function createWindowsProjects(deps: {
  desktop: () => boolean;
  platform: () => string | undefined;
  bridge: () => LinkedProjectsBridge | null;
  remoteControl: () => RemoteControlBridge | null;
  remote: (environmentId: EnvironmentId) => boolean;
  connected: (environmentId: EnvironmentId) => boolean;
  rpc: {
    create(
      environmentId: EnvironmentId,
      input: { hostId: string; winPath: string },
    ): Promise<DesktopLinkedProject & { created: boolean }>;
    unlink(
      environmentId: EnvironmentId,
      input: { projectId: ProjectId; deleteServerCopy: boolean },
    ): Promise<unknown>;
    resolveConflict(
      environmentId: EnvironmentId,
      input: { projectId: ProjectId; path: string },
    ): Promise<unknown>;
  };
  changed: (environmentId: EnvironmentId) => void;
  log: (message: string, error: unknown) => void;
}) {
  const local = async (environmentId: EnvironmentId, projectId: ProjectId) => {
    const bridge = deps.bridge();
    const record = (await bridge?.list())?.find(
      (record) => record.environmentId === environmentId && record.projectId === projectId,
    );
    if (!bridge || !record) throw new Error("This project is not linked on this desktop");
    return { bridge, record };
  };
  return {
    canCreateWindowsProject: (environmentId: EnvironmentId) =>
      deps.desktop() &&
      deps.platform() === "win32" &&
      deps.remote(environmentId) &&
      deps.bridge() !== null &&
      deps.connected(environmentId),
    createWindowsProject: async ({ environmentId }: { environmentId: EnvironmentId }) => {
      const bridge = deps.bridge();
      let winPath: string | null;
      let hostId: string;
      try {
        if (!bridge) throw new Error("Desktop linked-project bridge is unavailable");
        winPath = await bridge.pickFolder();
        if (winPath === null) return null;
        const control = deps.remoteControl();
        if (!control) throw new Error("Desktop host identity is unavailable");
        hostId = (await control.getHostIdentity()).hostId;
      } catch (cause) {
        throw new WindowsProjectError("picker", cause);
      }
      let link: DesktopLinkedProject & { created: boolean };
      try {
        link = await deps.rpc.create(environmentId, { hostId, winPath });
      } catch (cause) {
        throw new WindowsProjectError("server", cause);
      }
      deps.changed(environmentId);
      try {
        await bridge.register({ environmentId, link });
      } catch (cause) {
        // The server link remains recoverable; never unlink or delete a server copy here.
        deps.log("Server Windows project created but desktop sync registration failed", cause);
        // Preserve a native Error's identity and details for recovery callers.
        if (cause instanceof Error) {
          Object.assign(cause, { stage: "sync" });
          throw cause;
        }
        throw new WindowsProjectError("sync", cause);
      }
      return { projectId: link.projectId, created: link.created };
    },
    unlinkWindowsProject: async ({
      environmentId,
      projectId,
      deleteServerCopy,
    }: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      deleteServerCopy: boolean;
    }) => {
      await deps.rpc.unlink(environmentId, { projectId, deleteServerCopy });
      deps.changed(environmentId);
      const bridge = deps.bridge();
      const record = (await bridge?.list())?.find(
        (record) => record.environmentId === environmentId && record.projectId === projectId,
      );
      if (record) await bridge?.remove(record.id);
    },
    resolveWindowsConflict: async ({
      environmentId,
      projectId,
      path,
      keep,
    }: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      path: string;
      keep: "server" | "windows";
    }) => {
      const { bridge, record } = await local(environmentId, projectId);
      if (keep === "server") await bridge.resolveConflict({ id: record.id, path, keep });
      else {
        await deps.rpc.resolveConflict(environmentId, { projectId, path });
        await bridge.flush(record.id);
      }
    },
  };
}
