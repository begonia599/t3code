import type { LinkedSyncStatus } from "@t3tools/contracts";
import { MonitorIcon } from "lucide-react";

import { useT } from "~/i18n";
import { cn } from "~/lib/utils";
import type { WindowsProjectInfo } from "~/state/windowsProjects.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type SyncState = LinkedSyncStatus["state"];

export interface LinkedSyncPresentation {
  /** English source copy; pass through `t()` before rendering. */
  readonly label: string;
  readonly dotClassName: string;
  readonly pulse: boolean;
  readonly tone: "success" | "info" | "warning" | "error" | "muted";
}

/** One mapping from sync state to label and color, shared by every Windows project surface. */
export function linkedSyncPresentation(
  state: SyncState | undefined,
): LinkedSyncPresentation | null {
  switch (state) {
    case "synced":
      return { label: "Synced", dotClassName: "bg-success", pulse: false, tone: "success" };
    case "initial":
    case "syncing":
      return { label: "Syncing", dotClassName: "bg-info", pulse: true, tone: "info" };
    case "conflicts":
      return {
        label: "Needs attention",
        dotClassName: "bg-warning",
        pulse: false,
        tone: "warning",
      };
    case "paused":
      return {
        label: "Paused",
        dotClassName: "bg-muted-foreground/45",
        pulse: false,
        tone: "muted",
      };
    case "disconnected":
      return {
        label: "Waiting for connection",
        dotClassName: "bg-muted-foreground/45",
        pulse: false,
        tone: "muted",
      };
    case "error":
      return { label: "Sync stopped", dotClassName: "bg-destructive", pulse: false, tone: "error" };
    default:
      return null;
  }
}

/** Tooltip copy: where the files live, then how the sync is doing. */
export function useWindowsProjectSummary(info: WindowsProjectInfo): {
  readonly title: string;
  readonly detail: string;
  readonly sync: LinkedSyncPresentation | null;
} {
  const t = useT();
  const sync = linkedSyncPresentation(info.status?.state);
  const conflicts = info.status?.conflicts.length ?? 0;
  const syncText = sync
    ? sync.tone === "warning" && conflicts > 0
      ? t(
          conflicts === 1 ? "1 file changed on both sides" : "{count} files changed on both sides",
        ).replace("{count}", String(conflicts))
      : t(sync.label)
    : null;
  return {
    title: t("Windows folder on {host}").replace("{host}", info.link.hostName),
    detail: [info.link.winPath, syncText].filter(Boolean).join(" · "),
    sync,
  };
}

function SyncDot({ sync, className }: { sync: LinkedSyncPresentation; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "rounded-full",
        sync.dotClassName,
        sync.pulse && "animate-status-pulse",
        className,
      )}
    />
  );
}

/**
 * Sidebar project-row badge for a Windows-linked project. Occupies the same
 * end-of-row slot (and hover crossfade) as the remote-environment badge it replaces.
 */
export function WindowsProjectSidebarBadge({ info }: { info: WindowsProjectInfo }) {
  const summary = useWindowsProjectSummary(info);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={summary.title}
            className="pointer-events-none absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-md text-icon-muted transition-opacity duration-150 max-sm:right-7 group-hover/project-header:opacity-0 group-focus-within/project-header:opacity-0 max-sm:group-hover/project-header:opacity-100 max-sm:group-focus-within/project-header:opacity-100"
          />
        }
      >
        <span className="relative inline-flex">
          <MonitorIcon className="size-3" />
          {summary.sync ? (
            <SyncDot
              sync={summary.sync}
              className="absolute -right-0.5 -bottom-0.5 size-1.5 ring-2 ring-sidebar"
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-80">
        <span className="block font-medium">{summary.title}</span>
        <span className="block wrap-anywhere text-muted-foreground">{summary.detail}</span>
      </TooltipPopup>
    </Tooltip>
  );
}

/** Compact marker after the project name in the thread header. */
export function WindowsProjectHeaderMarker({
  info,
  onOpenSettings,
}: {
  info: WindowsProjectInfo;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const summary = useWindowsProjectSummary(info);
  const needsAttention = summary.sync?.tone === "warning" || summary.sync?.tone === "error";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`${summary.title}. ${summary.detail}`}
            onClick={onOpenSettings}
            className={cn(
              "inline-flex h-5 shrink-0 items-center gap-1 rounded-sm px-1 text-xs transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
              needsAttention
                ? summary.sync?.tone === "error"
                  ? "text-destructive-foreground hover:bg-destructive/8"
                  : "text-warning-foreground hover:bg-warning/8"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          />
        }
      >
        <MonitorIcon className="size-3.5" />
        <span className="max-w-28 truncate max-sm:hidden">{info.link.hostName}</span>
        {summary.sync ? <SyncDot sync={summary.sync} className="size-1.5" /> : null}
        {needsAttention ? <span className="max-sm:hidden">{t(summary.sync!.label)}</span> : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-80">
        <span className="block font-medium">{summary.title}</span>
        <span className="block wrap-anywhere text-muted-foreground">{summary.detail}</span>
        <span className="mt-1 block text-muted-foreground">{t("Click to manage sync")}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
