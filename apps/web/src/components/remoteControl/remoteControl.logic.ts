import type { DesktopExecLogEntry, RemoteControlGrantRequest } from "@t3tools/contracts";

/** `D:\…`, `D:/…` or a UNC share `\\server\share…`. The desktop validates again. */
export function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(value);
}

export function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith("/");
}

/** Electron prefixes rejected IPC calls with the channel name; users only need the cause. */
export function bridgeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:[A-Za-z]*Error:\s*)?/u, "")
    .trim();
}

/** `m:ss` until `deadline`, clamped at zero. */
export function formatCountdown(deadlineMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

export function providerLabel(provider: string | null): string | null {
  if (provider === null) return null;
  return PROVIDER_LABELS[provider] ?? provider;
}

/** Oldest first, so the dialog works through requests in arrival order. */
export function orderGrantRequests(
  requests: readonly RemoteControlGrantRequest[],
): RemoteControlGrantRequest[] {
  return [...requests].sort(
    (left, right) =>
      Date.parse(left.requestedAt) - Date.parse(right.requestedAt) ||
      left.grantRequestId.localeCompare(right.grantRequestId),
  );
}

export type ExecOutcomeTone = "success" | "error" | "warning" | "info";

/** English source strings; the caller translates `label` and fills `{code}`. */
export function describeExecOutcome(entry: DesktopExecLogEntry): {
  readonly label: string;
  readonly tone: ExecOutcomeTone;
  readonly code: string | null;
} {
  switch (entry.outcome) {
    case "running":
      return { label: "Running", tone: "info", code: null };
    case "exited":
      return entry.exitCode === 0
        ? { label: "Exit 0", tone: "success", code: null }
        : { label: "Exit {code}", tone: "warning", code: String(entry.exitCode ?? "?") };
    case "timedOut":
      return { label: "Timed out", tone: "warning", code: null };
    case "cancelled":
      return { label: "Cancelled", tone: "warning", code: null };
    case "error":
      return { label: "Error", tone: "error", code: null };
  }
}

export function formatAuditTime(iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}
