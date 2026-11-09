/**
 * `win` command protocol (M4). Three layers share these schemas:
 *
 *   win launcher ──HTTP/NDJSON──▶ WinGateway (server) ──DesktopChannel──▶ desktop main process
 *
 * DesktopChannel request kinds defined here: "exec", "log", "status" (plus "ping" from M3b).
 * Exec output travels as DesktopChannelEmit events: kind "stdout"/"stderr" carry decoded
 * UTF-8 text chunks (<= DESKTOP_EXEC_CHUNK_BYTES each); kind "progress" carries
 * JSON.stringify(DesktopExecProgress).
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DESKTOP_EXEC_KIND = "exec";
export const DESKTOP_EXEC_LOG_KIND = "log";
export const DESKTOP_STATUS_KIND = "status";

export const DESKTOP_EXEC_DEFAULT_TIMEOUT_MS = 600_000;
export const DESKTOP_EXEC_MAX_TIMEOUT_MS = 6 * 60 * 60_000;
/** Longest the desktop waits for the user to answer the grant dialog. */
export const DESKTOP_EXEC_GRANT_WAIT_MS = 120_000;
/** Server-side broker timeout = grant wait + exec timeout + this grace. */
export const DESKTOP_EXEC_TIMEOUT_GRACE_MS = 30_000;
export const DESKTOP_EXEC_CHUNK_BYTES = 16 * 1024;
/** stdout + stderr forwarded per request; beyond this output is dropped and a "truncated" progress is sent. */
export const DESKTOP_EXEC_OUTPUT_LIMIT_BYTES = 20 * 1024 * 1024;
export const DESKTOP_EXEC_MAX_CONCURRENT_PER_HOST = 4;
export const DESKTOP_EXEC_LOG_RETAINED = 200;
export const DESKTOP_EXEC_SUMMARY_MAX_CHARS = 500;

const EnvOverlay = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  Schema.String,
);

const execCommonFields = {
  /** Launcher process.cwd() on the server (absolute POSIX path). The desktop maps it to a Win path. */
  serverCwd: TrimmedNonEmptyString,
  /** Explicit `--cwd <Win path>`; overrides the mapping but must still be inside the allowlist. */
  winCwd: Schema.optional(TrimmedNonEmptyString),
  /** `--env K=V` overlay on top of the Win user environment. */
  env: EnvOverlay,
  /** Process timeout enforced by the desktop after spawn (kills the process tree). */
  timeoutMs: PositiveInt.check(Schema.isLessThanOrEqualTo(DESKTOP_EXEC_MAX_TIMEOUT_MS)),
  /** `--no-sync`: skip the `mutagen sync flush` barrier. */
  noSync: Schema.Boolean,
};

/** `win -- <program> [args...]`: argv goes to CreateProcess unchanged (.cmd/.bat via cmd.exe /d /s /c). */
export const DesktopExecArgvInput = Schema.Struct({
  mode: Schema.Literal("argv"),
  argv: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  ...execCommonFields,
});
export type DesktopExecArgvInput = typeof DesktopExecArgvInput.Type;

/** `win ps '<script>'`: script is fed to pwsh / powershell.exe via stdin. */
export const DesktopExecPowerShellInput = Schema.Struct({
  mode: Schema.Literal("powershell"),
  script: Schema.String.check(Schema.isMinLength(1)),
  ...execCommonFields,
});
export type DesktopExecPowerShellInput = typeof DesktopExecPowerShellInput.Type;

/** DesktopChannelRequest.input for kind "exec". */
export const DesktopExecInput = Schema.Union([DesktopExecArgvInput, DesktopExecPowerShellInput]);
export type DesktopExecInput = typeof DesktopExecInput.Type;

/** JSON payload of an exec "progress" event. */
export const DesktopExecProgress = Schema.Union([
  Schema.Struct({ type: Schema.Literal("awaiting-grant") }),
  Schema.Struct({ type: Schema.Literal("syncing"), session: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("queued") }),
  Schema.Struct({
    type: Schema.Literal("started"),
    pid: NonNegativeInt,
    winCwd: TrimmedNonEmptyString,
    /** Resolved executable, e.g. "pwsh", "powershell.exe", "cmd.exe", or argv[0]. */
    executable: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("truncated"), limitBytes: PositiveInt }),
]);
export type DesktopExecProgress = typeof DesktopExecProgress.Type;

/**
 * DesktopChannelResponse.result for kind "exec". Timeout and cancellation after spawn are
 * results (not errors) so partial output and the audit record stay consistent.
 */
export const DesktopExecResult = Schema.Struct({
  outcome: Schema.Literals(["exited", "timedOut", "cancelled"]),
  /** Process exit code; null when killed without one. */
  exitCode: Schema.NullOr(Schema.Int),
  durationMs: NonNegativeInt,
  winCwd: TrimmedNonEmptyString,
  stdoutBytes: NonNegativeInt,
  stderrBytes: NonNegativeInt,
  truncated: Schema.Boolean,
  /** Output was not valid UTF-8 and was decoded as GBK (code page 936). */
  decodedAsGbk: Schema.Boolean,
});
export type DesktopExecResult = typeof DesktopExecResult.Type;

/**
 * DesktopChannelResponse.error.code values the desktop uses for "exec" / "log" / "status".
 * The broker surfaces them as DesktopChannelError{code: "HOST_ERROR", remoteCode}.
 */
export const DesktopExecErrorCode = Schema.Literals([
  /** Environment switch is off on the desktop. */
  "REMOTE_DISABLED",
  /** User clicked "deny" in the grant dialog, or the grant was revoked. */
  "GRANT_DENIED",
  /** Nobody answered the grant dialog within DESKTOP_EXEC_GRANT_WAIT_MS. */
  "GRANT_TIMEOUT",
  /** serverCwd is not under any path mapping and no winCwd was given. */
  "CWD_NOT_MAPPED",
  /** Resolved Win cwd is outside every allowlist root, or does not exist. */
  "CWD_NOT_ALLOWED",
  /** `mutagen sync flush` failed (use --no-sync to skip). */
  "SYNC_FAILED",
  /** Program not found (ENOENT). */
  "SPAWN_NOT_FOUND",
  /** Other spawn failure. */
  "SPAWN_FAILED",
  /** Input failed schema validation. */
  "BAD_REQUEST",
  "UNSUPPORTED_KIND",
  "CANCELLED",
  "INTERNAL",
]);
export type DesktopExecErrorCode = typeof DesktopExecErrorCode.Type;

/** DesktopChannelRequest.input for kind "log". */
export const DesktopExecLogInput = Schema.Struct({
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(DESKTOP_EXEC_LOG_RETAINED)),
});
export type DesktopExecLogInput = typeof DesktopExecLogInput.Type;

/** One audit record; the desktop JSONL log is authoritative, the server table mirrors it. */
export const DesktopExecLogEntry = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  mode: Schema.Literals(["argv", "powershell"]),
  /** Command summary, at most DESKTOP_EXEC_SUMMARY_MAX_CHARS. */
  summary: Schema.String,
  winCwd: Schema.NullOr(Schema.String),
  /** "running" only while in flight (or if the desktop crashed mid-run). */
  outcome: Schema.Literals(["running", "exited", "timedOut", "cancelled", "error"]),
  exitCode: Schema.NullOr(Schema.Int),
  errorCode: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(NonNegativeInt),
});
export type DesktopExecLogEntry = typeof DesktopExecLogEntry.Type;

export const DesktopExecLogResult = Schema.Struct({
  entries: Schema.Array(DesktopExecLogEntry),
});
export type DesktopExecLogResult = typeof DesktopExecLogResult.Type;

export const DesktopPathMapping = Schema.Struct({
  serverPath: TrimmedNonEmptyString,
  winPath: TrimmedNonEmptyString,
  /** Mutagen session name flushed before exec in this mapping. */
  syncSession: Schema.optional(TrimmedNonEmptyString),
});
export type DesktopPathMapping = typeof DesktopPathMapping.Type;

/** DesktopChannelRequest.input for kind "status" (threadId comes from request.context). */
export const DesktopStatusInput = Schema.Struct({});

export const DesktopStatusResult = Schema.Struct({
  enabled: Schema.Boolean,
  strictMode: Schema.Boolean,
  /** Grant state of request.context.threadId. */
  grant: Schema.Literals(["granted", "none", "denied"]),
  allowlist: Schema.Array(Schema.String),
  mappings: Schema.Array(DesktopPathMapping),
  running: NonNegativeInt,
  shells: Schema.Array(Schema.String),
});
export type DesktopStatusResult = typeof DesktopStatusResult.Type;

// ---------------------------------------------------------------------------
// Launcher <-> WinGateway HTTP (`/agent-win/v1/*`)
// ---------------------------------------------------------------------------

export const WIN_GATEWAY_PATH_PREFIX = "/agent-win/v1";
/** Header carrying T3_WIN_LABEL (codex-delegate --label). */
export const WIN_GATEWAY_LABEL_HEADER = "x-t3-win-label";

/** POST /agent-win/v1/exec body. `host` selects by hostId or hostName when several are online. */
export const WinGatewayExecRequest = Schema.Struct({
  exec: DesktopExecInput,
  host: Schema.optional(TrimmedNonEmptyString),
});
export type WinGatewayExecRequest = typeof WinGatewayExecRequest.Type;

/** Gateway-level error codes (desktop codes pass through unchanged). */
export const WinGatewayErrorCode = Schema.Literals([
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "HOST_OFFLINE",
  "HOST_AMBIGUOUS",
  "HOST_NOT_FOUND",
  "HOST_DISABLED",
  "HOST_BUSY",
  "HOST_DISCONNECTED",
  "TIMEOUT",
  "CANCELLED",
  "INTERNAL",
]);
export type WinGatewayErrorCode = typeof WinGatewayErrorCode.Type;

/**
 * One NDJSON line of the /exec response stream. A well-formed stream ends with exactly one
 * "result" or "error" line; a stream that ends without one means the state on Win is unknown.
 */
export const WinGatewayExecLine = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("accepted"),
    requestId: TrimmedNonEmptyString,
    hostId: TrimmedNonEmptyString,
    hostName: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("progress"), progress: DesktopExecProgress }),
  Schema.Struct({ type: Schema.Literal("stdout"), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stderr"), data: Schema.String }),
  Schema.Struct({ type: Schema.Literal("result"), result: DesktopExecResult }),
  Schema.Struct({
    type: Schema.Literal("error"),
    /** WinGatewayErrorCode or a passed-through DesktopExecErrorCode. */
    code: TrimmedNonEmptyString,
    message: Schema.String,
  }),
]);
export type WinGatewayExecLine = typeof WinGatewayExecLine.Type;

export const WinGatewayHostSummary = Schema.Struct({
  hostId: TrimmedNonEmptyString,
  hostName: TrimmedNonEmptyString,
  platform: TrimmedNonEmptyString,
  appVersion: TrimmedNonEmptyString,
  connectedAt: Schema.String,
  execEnabled: Schema.Boolean,
});
export type WinGatewayHostSummary = typeof WinGatewayHostSummary.Type;

/** GET /agent-win/v1/status[?host=...] */
export const WinGatewayStatusResponse = Schema.Struct({
  threadId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  hosts: Schema.Array(WinGatewayHostSummary),
  /** Host that `win` would use now (null when offline or ambiguous). */
  selectedHostId: Schema.NullOr(Schema.String),
  /** "status" result from the selected host; null if offline, or an error code string. */
  hostStatus: Schema.NullOr(DesktopStatusResult),
  hostStatusError: Schema.NullOr(Schema.String),
});
export type WinGatewayStatusResponse = typeof WinGatewayStatusResponse.Type;

/** GET /agent-win/v1/log?n=20[&host=...]: from the host when online, else the server mirror. */
export const WinGatewayLogResponse = Schema.Struct({
  source: Schema.Literals(["host", "server"]),
  entries: Schema.Array(DesktopExecLogEntry),
});
export type WinGatewayLogResponse = typeof WinGatewayLogResponse.Type;

// ---------------------------------------------------------------------------
// Launcher exit codes (120-127; everything else is the remote process exit code)
// ---------------------------------------------------------------------------

export const WIN_EXIT_UNAUTHORIZED = 120;
export const WIN_EXIT_HOST_UNAVAILABLE = 121;
export const WIN_EXIT_STATE_UNKNOWN = 122;
export const WIN_EXIT_REJECTED = 123;
export const WIN_EXIT_TIMEOUT = 124;
export const WIN_EXIT_USAGE = 125;
export const WIN_EXIT_DENIED = 126;
export const WIN_EXIT_NOT_FOUND = 127;
export const WIN_EXIT_CANCELLED = 130;

/** Exit code the launcher uses for an "error" line. */
export const winExitCodeForError = (code: string): number => {
  switch (code) {
    case "UNAUTHORIZED":
      return WIN_EXIT_UNAUTHORIZED;
    case "HOST_OFFLINE":
    case "HOST_AMBIGUOUS":
    case "HOST_NOT_FOUND":
    case "HOST_DISABLED":
    case "HOST_BUSY":
    case "REMOTE_DISABLED":
      return WIN_EXIT_HOST_UNAVAILABLE;
    case "HOST_DISCONNECTED":
      return WIN_EXIT_STATE_UNKNOWN;
    case "TIMEOUT":
      return WIN_EXIT_TIMEOUT;
    case "GRANT_DENIED":
    case "GRANT_TIMEOUT":
      return WIN_EXIT_DENIED;
    case "SPAWN_NOT_FOUND":
      return WIN_EXIT_NOT_FOUND;
    case "CANCELLED":
      return WIN_EXIT_CANCELLED;
    case "BAD_REQUEST":
      return WIN_EXIT_USAGE;
    default:
      return WIN_EXIT_REJECTED;
  }
};

/** Exit code the launcher uses for a "result" line. */
export const winExitCodeForResult = (result: DesktopExecResult): number => {
  switch (result.outcome) {
    case "timedOut":
      return WIN_EXIT_TIMEOUT;
    case "cancelled":
      return WIN_EXIT_CANCELLED;
    case "exited":
      return result.exitCode ?? WIN_EXIT_STATE_UNKNOWN;
  }
};
