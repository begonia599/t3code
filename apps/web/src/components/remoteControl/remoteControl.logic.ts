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
      if (entry.mode === "mcp") {
        // A tool call has no exit code; it either returned normally or reported an error.
        return entry.errorCode === "MCP_TOOL_ERROR"
          ? { label: "Tool error", tone: "warning", code: null }
          : { label: "Done", tone: "success", code: null };
      }
      return entry.exitCode === 0
        ? { label: "Exit 0", tone: "success", code: null }
        : { label: "Exit {code}", tone: "warning", code: String(entry.exitCode ?? "?") };
    case "timedOut":
      return { label: "Timed out", tone: "warning", code: null };
    case "cancelled":
      return { label: "Cancelled", tone: "warning", code: null };
    case "unknown":
      return { label: "Unknown", tone: "warning", code: null };
    case "error":
      return { label: "Error", tone: "error", code: null };
  }
}

/** Why a request's result is unknown, as English source strings. */
const UNKNOWN_RESULT_REASONS: Readonly<Record<string, string>> = {
  HOST_DISCONNECTED: "Connection dropped mid-run",
  HOST_REPLACED: "Connection dropped mid-run",
  CLEANUP_FAILED: "Process didn't shut down cleanly",
  SERVER_RESTARTED: "Server restarted mid-run",
};

/**
 * The short reason shown next to an entry, or null when the outcome badge says it all.
 * `translate` is false for raw error codes, which stay as-is.
 */
export function describeExecReason(
  entry: DesktopExecLogEntry,
): { readonly text: string; readonly translate: boolean } | null {
  if (entry.outcome === "unknown") {
    const reason = entry.errorCode === null ? undefined : UNKNOWN_RESULT_REASONS[entry.errorCode];
    return reason === undefined
      ? entry.errorCode === null
        ? null
        : { text: entry.errorCode, translate: false }
      : { text: reason, translate: true };
  }
  if (entry.outcome === "error" && entry.errorCode !== null) {
    return { text: entry.errorCode, translate: false };
  }
  return null;
}

/** `<serverId>__<toolName>` → its two halves; null when the summary isn't in that shape. */
export function splitMcpSummary(
  summary: string,
): { readonly server: string; readonly tool: string } | null {
  const separator = summary.indexOf("__");
  if (separator <= 0 || separator + 2 >= summary.length) return null;
  return { server: summary.slice(0, separator), tool: summary.slice(separator + 2) };
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
