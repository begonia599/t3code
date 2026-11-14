/**
 * Windows folders: projects whose files live in a folder on this PC and sync
 * to a copy on the server. Everything here is automatic; the list only shows
 * how each folder is doing and offers the few choices a person has to make
 * (pause, unlink, which side of a conflict to keep).
 *
 * @module WindowsFoldersSettings
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { AlertTriangleIcon, PauseIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useT } from "~/i18n";
import { cn } from "~/lib/utils";
import { useProject } from "~/state/entities";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import {
  resolveWindowsConflict,
  unlinkWindowsProject,
  useLinkedProjects,
} from "~/state/windowsProjects";
import type { WindowsProjectInfo } from "~/state/windowsProjects.logic";

import { bridgeErrorMessage, formatAuditTime } from "../remoteControl/remoteControl.logic";
import { readLinkedProjectsBridge } from "../remoteControl/useRemoteControl";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { linkedSyncPresentation } from "../windowsProjects/WindowsProjectBadge";
import { WINDOWS_FOLDERS_SETTINGS_ID } from "../windowsProjects/windowsProjectCopy";
import { SettingsSection } from "./settingsLayout";

/** Linked folders only exist in the Windows desktop app. */
export function windowsFoldersAvailable(): boolean {
  return (
    isElectron &&
    typeof window !== "undefined" &&
    window.desktopBridge?.getClientPlatform?.() === "win32" &&
    readLinkedProjectsBridge() !== null
  );
}

function isRemoteEnvironment(environment: EnvironmentPresentation): boolean {
  const target = environment.entry.target;
  return target._tag !== "PrimaryConnectionTarget" && !isDesktopLocalConnectionTarget(target);
}

export function WindowsFoldersSettings({ hostId }: { hostId: string | null }) {
  const t = useT();
  const { environments } = useEnvironments();
  const remote = environments.filter(isRemoteEnvironment);
  return (
    <SettingsSection id={WINDOWS_FOLDERS_SETTINGS_ID} title="Windows folders">
      <div className="px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          {t(
            "Projects you add from a folder on this PC. Files stay here and sync with a copy on the server, so agents can work on them and run commands here.",
          )}
        </p>
        {/* Rows come from one component per server; the hint shows only while none rendered. */}
        <div className="peer pt-2">
          {remote.map((environment) => (
            <EnvironmentWindowsFolders
              key={environment.environmentId}
              environment={environment}
              hostId={hostId}
            />
          ))}
        </div>
        <p className="hidden border-t border-border/50 py-2.5 text-sm text-muted-foreground peer-empty:block">
          {t("No folders yet. Use New project → Folder on this PC to add one.")}
        </p>
      </div>
    </SettingsSection>
  );
}

function EnvironmentWindowsFolders({
  environment,
  hostId,
}: {
  environment: EnvironmentPresentation;
  hostId: string | null;
}) {
  const t = useT();
  const { projects, error } = useLinkedProjects(environment.environmentId);
  const mine = [...projects.values()].filter(
    (info) => info.local !== undefined || (hostId !== null && info.link.hostId === hostId),
  );
  if (mine.length === 0) {
    return error && environment.connection.phase === "connected" ? (
      <p className="border-t border-border/50 py-2.5 text-xs text-destructive-foreground">
        {t("Couldn't load Windows folders from {server}.").replace("{server}", environment.label)}
      </p>
    ) : null;
  }
  return mine.map((info) => (
    <WindowsFolderRow
      key={info.link.projectId}
      environmentId={environment.environmentId}
      serverLabel={environment.label}
      info={info}
    />
  ));
}

function folderName(winPath: string): string {
  const parts = winPath.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? winPath;
}

function notify(title: string, cause: unknown) {
  toastManager.add({ type: "error", title, description: bridgeErrorMessage(cause) });
}

function WindowsFolderRow({
  environmentId,
  serverLabel,
  info,
}: {
  environmentId: EnvironmentId;
  serverLabel: string;
  info: WindowsProjectInfo;
}) {
  const t = useT();
  const project = useProject(scopeProjectRef(environmentId, info.link.projectId));
  const [busy, setBusy] = useState(false);
  const [unlinkOpen, setUnlinkOpen] = useState(false);
  const name = project?.title ?? folderName(info.link.winPath);
  const record = info.local;
  const status = info.status;
  const sync = record ? linkedSyncPresentation(status?.state) : null;
  const conflicts = record ? (status?.conflicts ?? []) : [];

  const run = async (failureTitle: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      notify(t(failureTitle), cause);
    } finally {
      setBusy(false);
    }
  };

  const statusText = !record
    ? t("Not syncing on this PC")
    : status?.state === "synced" && status.lastSyncedAt
      ? t("Synced {time}").replace("{time}", formatAuditTime(status.lastSyncedAt, new Date()))
      : sync
        ? t(sync.label)
        : t("Starting…");

  return (
    <div className="border-t border-border/50 py-2.5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            sync ? sync.dotClassName : "bg-muted-foreground/30",
            sync?.pulse && "animate-status-pulse",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{name}</p>
          <p className="text-xs wrap-anywhere text-muted-foreground">
            <span
              className={cn(
                sync?.tone === "warning" && "text-warning-foreground",
                sync?.tone === "error" && "text-destructive-foreground",
              )}
            >
              {statusText}
            </span>
            {" · "}
            {serverLabel}
            {" · "}
            {info.link.winPath}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {record ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={record.paused ? t("Resume sync") : t("Pause sync")}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        record.paused ? "Couldn't resume sync" : "Couldn't pause sync",
                        async () => {
                          const bridge = readLinkedProjectsBridge();
                          if (!bridge) throw new Error("Desktop sync is unavailable");
                          await (record.paused
                            ? bridge.resume(record.id)
                            : bridge.pause(record.id));
                        },
                      )
                    }
                  />
                }
              >
                {record.paused ? (
                  <PlayIcon className="size-3.5" />
                ) : (
                  <PauseIcon className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {record.paused ? t("Resume sync") : t("Pause sync")}
              </TooltipPopup>
            </Tooltip>
          ) : (
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run("Couldn't reconnect sync", async () => {
                  const bridge = readLinkedProjectsBridge();
                  if (!bridge) throw new Error("Desktop sync is unavailable");
                  await bridge.register({ environmentId, link: info.link });
                })
              }
            >
              <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
              {t("Reconnect sync")}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={busy}
            onClick={() => setUnlinkOpen(true)}
          >
            {t("Unlink")}
          </Button>
        </div>
      </div>

      {status?.state === "error" && status.message ? (
        <p className="ms-5 pt-1.5 text-xs wrap-anywhere text-destructive-foreground">
          {status.message}
        </p>
      ) : null}

      {conflicts.length > 0 ? (
        <div className="ms-5 mt-2 rounded-lg border border-warning/30 bg-warning/6 px-3 py-2">
          <p className="flex items-center gap-1.5 text-xs text-warning-foreground">
            <AlertTriangleIcon aria-hidden className="size-3.5 shrink-0" />
            {t(
              conflicts.length === 1
                ? "1 file changed on both sides. Choose which version to keep."
                : "{count} files changed on both sides. Choose which version to keep.",
            ).replace("{count}", String(conflicts.length))}
          </p>
          <ul className="pt-1">
            {conflicts.map((conflict) => (
              <li
                key={conflict.path}
                className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-warning/15 py-1.5 first:border-t-0"
              >
                <span className="min-w-0 flex-1 basis-48 font-mono text-xs wrap-anywhere">
                  {conflict.path}
                </span>
                <div className="flex shrink-0 gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run("Couldn't resolve the conflict", () =>
                        resolveWindowsConflict({
                          environmentId,
                          projectId: info.link.projectId,
                          path: conflict.path,
                          keep: "windows",
                        }),
                      )
                    }
                  >
                    {t("Keep this PC's version")}
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run("Couldn't resolve the conflict", () =>
                        resolveWindowsConflict({
                          environmentId,
                          projectId: info.link.projectId,
                          path: conflict.path,
                          keep: "server",
                        }),
                      )
                    }
                  >
                    {t("Keep server version")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <UnlinkWindowsFolderDialog
        open={unlinkOpen}
        onOpenChange={setUnlinkOpen}
        name={name}
        serverLabel={serverLabel}
        onConfirm={(deleteServerCopy) =>
          run("Couldn't unlink the folder", async () => {
            await unlinkWindowsProject({
              environmentId,
              projectId: info.link.projectId,
              deleteServerCopy,
            });
            toastManager.add({
              type: "success",
              title: t("Folder unlinked"),
              description: deleteServerCopy
                ? t("The project and its server copy were deleted. Files on this PC are unchanged.")
                : t("The project stays on the server. Files on this PC are unchanged."),
            });
          })
        }
      />
    </div>
  );
}

function UnlinkWindowsFolderDialog({
  open,
  onOpenChange,
  name,
  serverLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  serverLabel: string;
  onConfirm: (deleteServerCopy: boolean) => Promise<void>;
}) {
  const t = useT();
  const [deleteServerCopy, setDeleteServerCopy] = useState(false);
  const [pending, setPending] = useState(false);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
        if (!next) setDeleteServerCopy(false);
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("Unlink {name}?").replace("{name}", name)}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("Syncing stops. Files on this PC are never deleted.")}
          </AlertDialogDescription>
          <label className="mt-2 flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/70 px-3 py-2.5 text-left">
            <Checkbox
              className="mt-0.5"
              checked={deleteServerCopy}
              onCheckedChange={(checked) => setDeleteServerCopy(checked === true)}
            />
            <span className="min-w-0">
              <span className="block text-sm">
                {t("Also delete the project on {server}").replace("{server}", serverLabel)}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t(
                  "Removes the server copy of the files too. Leave this off to keep using the project on the server.",
                )}
              </span>
            </span>
          </label>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose disabled={pending} render={<Button variant="outline" />}>
            {t("Cancel")}
          </AlertDialogClose>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void onConfirm(deleteServerCopy).finally(() => {
                setPending(false);
                setDeleteServerCopy(false);
                onOpenChange(false);
              });
            }}
          >
            {deleteServerCopy ? t("Unlink and delete") : t("Unlink")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
