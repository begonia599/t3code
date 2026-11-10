/**
 * Windows file synchronization transport:
 *
 * mutagen.exe -> ssh.exe shim -> desktop main relay -> WebSocket -> server -> mutagen-agent stdio
 *
 * Text frames contain JSON control messages. The first client message must be `open`.
 * Binary messages carry stdin towards the agent and stdout towards the client, unchanged.
 * Split byte streams into messages of at most DESKTOP_SYNC_MAX_FRAME_BYTES; message boundaries
 * have no meaning to Mutagen. `stdin-eof` half-closes stdin; stdout continues until `exit`.
 * Stderr is UTF-8 text, capped per tunnel. `exit` follows all stdout, then close code 1000.
 * WebSocket ping/pong supplies liveness independently of the Mutagen byte stream.
 */
import * as Schema from "effect/Schema";

export const MUTAGEN_VERSION = "0.18.1";
export const DESKTOP_SYNC_TUNNEL_PATH = "/api/desktop-sync/v1/tunnel";
export const DESKTOP_SYNC_MAX_FRAME_BYTES = 64 * 1024;
export const DESKTOP_SYNC_SEND_HIGH_WATER_BYTES = 1024 * 1024;
export const DESKTOP_SYNC_HEARTBEAT_INTERVAL_MS = 15_000;
export const DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DESKTOP_SYNC_MAX_CONCURRENT_PER_ENVIRONMENT = 8;
export const DESKTOP_SYNC_STDERR_LIMIT_BYTES = 64 * 1024;
export const DESKTOP_SYNC_OPEN_TIMEOUT_MS = 10_000;
export const DESKTOP_SYNC_TERMINATE_GRACE_MS = 5_000;

export const DesktopSyncClientMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("open"), command: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stdin-eof") }),
]);
export type DesktopSyncClientMessage = typeof DesktopSyncClientMessage.Type;

export const DesktopSyncErrorCode = Schema.Literals([
  "COMMAND_REJECTED",
  "VERSION_MISMATCH",
  "AGENT_MISSING",
  "SPAWN_FAILED",
  "TOO_MANY_TUNNELS",
  "PROTOCOL_ERROR",
  "OPEN_TIMEOUT",
]);
export type DesktopSyncErrorCode = typeof DesktopSyncErrorCode.Type;

export const DesktopSyncServerMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("stderr"), data: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("exit"),
    code: Schema.NullOr(Schema.Int),
    signal: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("error"),
    code: DesktopSyncErrorCode,
    message: Schema.String,
  }),
]);
export type DesktopSyncServerMessage = typeof DesktopSyncServerMessage.Type;
