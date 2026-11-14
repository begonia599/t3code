// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Desktop authority serializes native sync and settings mutations and owns its polling lifecycle.
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type {
  DesktopLinkedFolder,
  RegisterLinkedProject,
  LinkedSyncStatus,
} from "@t3tools/contracts";
import {
  DesktopAppSettings,
  normalizeLinkedProjects,
  type DesktopSettings,
} from "../settings/DesktopAppSettings.ts";
import { ElectronWindow } from "../electron/ElectronWindow.ts";
import { createLinkedSync } from "./LinkedSync.ts";
import { SyncEnvironment } from "./SyncEnvironment.ts";
import { removeWindowsConflict } from "./linkedConflict.ts";
import * as Channels from "../ipc/channels.ts";

export function createLinkedProjects(options: {
  getConfig: () => Promise<DesktopSettings["remoteControl"]>;
  setRecords: (records: readonly DesktopLinkedFolder[]) => Promise<unknown>;
  sync: ReturnType<typeof createLinkedSync>;
  onChanged?: (records: readonly DesktopLinkedFolder[]) => void;
  onStatusChanged?: (statuses: readonly LinkedSyncStatus[]) => void;
  visible?: () => Promise<boolean>;
}) {
  let chain = Promise.resolve();
  let stopped = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastStatuses = "";
  const serial = <A>(run: () => Promise<A>) => {
    const task = chain.then(run);
    chain = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  const list = async () => [...(await options.getConfig()).linkedProjects];
  const find = async (id: string) => {
    const record = (await list()).find((record) => record.id === id);
    if (!record) throw new Error("Unknown linked project");
    return record;
  };
  const refresh = async () => {
    const statuses = await options.sync.refresh(await list(), true);
    const encoded = JSON.stringify(statuses);
    if (encoded !== lastStatuses) {
      lastStatuses = encoded;
      options.onStatusChanged?.(statuses);
    }
    return statuses;
  };
  const save = async (records: readonly DesktopLinkedFolder[]) => {
    await options.setRecords(normalizeLinkedProjects(records));
    options.onChanged?.(records);
  };
  const service = {
    list,
    getStatuses: async (): Promise<LinkedSyncStatus[]> => {
      const cached = options.sync.getStatuses();
      return (await list()).map(
        (record) =>
          cached.find((status) => status.linkId === record.id) ?? {
            linkId: record.id,
            state: record.paused ? "paused" : "initial",
            conflicts: [],
          },
      );
    },
    register: (input: typeof RegisterLinkedProject.Type) =>
      serial(async () => {
        const config = await options.getConfig();
        if (input.link.hostId !== config.hostId)
          throw new Error("Linked project belongs to another desktop host");
        const existing = config.linkedProjects.find(
          (record) =>
            record.environmentId === input.environmentId &&
            record.projectId === input.link.projectId,
        );
        if (existing) {
          await options.sync.ensure(existing);
          await refresh();
          return existing;
        }
        const id = NodeCrypto.randomUUID();
        const record: DesktopLinkedFolder = {
          id,
          environmentId: input.environmentId,
          projectId: input.link.projectId,
          hostId: input.link.hostId,
          serverPath: input.link.serverPath,
          winPath: input.link.winPath,
          createdAt: input.link.createdAt,
          paused: false,
          syncSession: `t3-link-${id.slice(0, 8)}`,
        };
        const records = normalizeLinkedProjects([...config.linkedProjects, record]);
        const normalized = records.at(-1)!;
        // Persist before starting sync: only a durable local record can authorize this folder.
        await options.setRecords(records);
        try {
          await options.sync.create(normalized);
        } catch (error) {
          await options.sync.terminate(normalized).catch(() => {});
          await options.setRecords(config.linkedProjects);
          throw new Error(`Cannot create desktop synchronization: ${String(error)}`, {
            cause: error,
          });
        }
        options.onChanged?.(records);
        await refresh();
        return normalized;
      }),
    pause: (id: string) =>
      serial(async () => {
        const record = await find(id);
        await options.sync.pause(record);
        await save(
          (await list()).map((item) => (item.id === id ? { ...item, paused: true } : item)),
        );
        await refresh();
      }),
    resume: (id: string) =>
      serial(async () => {
        const record = await find(id);
        await options.sync.ensure({ ...record, paused: false });
        await save(
          (await list()).map((item) => (item.id === id ? { ...item, paused: false } : item)),
        );
        await refresh();
      }),
    remove: (id: string) =>
      serial(async () => {
        const record = (await list()).find((record) => record.id === id);
        if (!record) return;
        await options.sync.terminate(record);
        await save((await list()).filter((item) => item.id !== id));
        await refresh();
      }),
    flush: (id: string) =>
      serial(async () => {
        await options.sync.flush(await find(id));
        await refresh();
      }),
    resolveConflict: (input: { id: string; path: string; keep: "server" }) =>
      serial(async () => {
        const record = await find(input.id);
        await removeWindowsConflict(record.winPath, input.path);
        await options.sync.flush(record);
        await refresh();
      }),
    start() {
      if (started || stopped) return;
      started = true;
      const tick = async () => {
        try {
          await serial(refresh);
        } finally {
          if (!stopped) {
            const visible = (await options.visible?.().catch(() => false)) ?? true;
            if (!stopped)
              timer = setTimeout(
                () => {
                  void tick().catch(() => {});
                },
                visible ? 2000 : 10000,
              );
          }
        }
      };
      void tick().catch(() => {});
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await chain;
    },
  };
  return service;
}
export class LinkedProjects extends Context.Service<
  LinkedProjects,
  ReturnType<typeof createLinkedProjects>
>()("@t3tools/desktop/sync/LinkedProjects") {}
export const layer = Layer.effect(
  LinkedProjects,
  Effect.gen(function* () {
    const settings = yield* DesktopAppSettings;
    const sync = yield* SyncEnvironment;
    const windows = yield* ElectronWindow;
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const publish = (channel: string, value: unknown) => {
      void run(windows.sendAll(channel, value)).catch(() => {});
    };
    const service = createLinkedProjects({
      getConfig: async () => (await run(settings.get)).remoteControl,
      setRecords: (records) => run(settings.setLinkedProjects(records)),
      sync: createLinkedSync(sync),
      onChanged: (records) => publish(Channels.LINKED_PROJECTS_CHANGED_CHANNEL, records),
      onStatusChanged: (statuses) =>
        publish(Channels.LINKED_PROJECTS_STATUS_CHANGED_CHANNEL, statuses),
      visible: async () => {
        const window = await run(windows.currentMainOrFirst);
        return Option.isSome(window) && !window.value.isDestroyed() && window.value.isVisible();
      },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => service.stop()));
    return service;
  }),
);
