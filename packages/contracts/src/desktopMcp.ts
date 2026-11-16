import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Version advertised in `DesktopChannelCapabilities.mcp.version`. */
export const DESKTOP_MCP_VERSION = "1";
/** Desktop channel request kind for one forwarded `tools/call`. */
export const DESKTOP_MCP_CALL_KIND = "mcp.call";
/** Hard deadline for one forwarded tool call, including progress time. */
export const DESKTOP_MCP_CALL_TIMEOUT_MS = 120_000;
/** Max concurrent forwarded calls per Windows host (all environments together). */
export const DESKTOP_MCP_MAX_CONCURRENT_CALLS = 8;
/** Name of the session-level aggregate MCP server injected into providers. */
export const WIN_MCP_SERVER_NAME = "t3-win";
/** Separator between local server id and tool name in aggregate tool names. */
export const WIN_MCP_TOOL_SEPARATOR = "__";

/**
 * Local MCP id: lowercase, starts with a letter, 1–24 chars, no `__`
 * (the aggregate separator). Becomes the tool prefix, e.g. `unity__get_hierarchy`.
 */
export const LocalMcpServerId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9_-]{0,23}$/),
  Schema.makeFilter((id: string) => !id.includes("__") || "must not contain '__'"),
);
export type LocalMcpServerId = typeof LocalMcpServerId.Type;

export const LocalMcpStdioTransport = Schema.Struct({
  type: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  /** Windows working directory; omitted means the user's home directory. */
  cwd: Schema.optional(Schema.String),
});
export type LocalMcpStdioTransport = typeof LocalMcpStdioTransport.Type;

export const LocalMcpHttpTransport = Schema.Struct({
  type: Schema.Literal("http"),
  /** Streamable HTTP endpoint on the Windows machine, e.g. http://127.0.0.1:8080/mcp */
  url: TrimmedNonEmptyString,
  headers: Schema.Record(Schema.String, Schema.String),
});
export type LocalMcpHttpTransport = typeof LocalMcpHttpTransport.Type;

export const LocalMcpTransport = Schema.Union([LocalMcpStdioTransport, LocalMcpHttpTransport]);
export type LocalMcpTransport = typeof LocalMcpTransport.Type;

/** Persisted in desktop settings (`remoteControl.localMcpServers`). Never sent to the server. */
export const LocalMcpServerConfig = Schema.Struct({
  id: LocalMcpServerId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  transport: LocalMcpTransport,
});
export type LocalMcpServerConfig = typeof LocalMcpServerConfig.Type;

/** Tool descriptor as reported by the local MCP (protocol fields kept verbatim). */
export const LocalMcpTool = Schema.Struct({
  name: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Unknown,
  outputSchema: Schema.optional(Schema.Unknown),
  annotations: Schema.optional(Schema.Unknown),
});
export type LocalMcpTool = typeof LocalMcpTool.Type;

export const LocalMcpServerStatus = Schema.Literals(["stopped", "starting", "running", "failed"]);
export type LocalMcpServerStatus = typeof LocalMcpServerStatus.Type;

/** Config + live state, for the settings UI. */
export const LocalMcpServerView = Schema.Struct({
  config: LocalMcpServerConfig,
  status: LocalMcpServerStatus,
  /** Last start/list error, human readable. */
  error: Schema.optional(Schema.String),
  /** Last successfully listed tools; kept while failed so the catalog stays stable. */
  tools: Schema.Array(LocalMcpTool),
  /** ISO time of the last successful tools/list. */
  toolsUpdatedAt: Schema.optional(Schema.String),
});
export type LocalMcpServerView = typeof LocalMcpServerView.Type;

export const LocalMcpProbeResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    serverName: Schema.optional(Schema.String),
    serverVersion: Schema.optional(Schema.String),
    tools: Schema.Array(LocalMcpTool),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
export type LocalMcpProbeResult = typeof LocalMcpProbeResult.Type;

export const LocalMcpServerIdInput = Schema.Struct({ id: LocalMcpServerId });
export const LocalMcpSetEnabledInput = Schema.Struct({
  id: LocalMcpServerId,
  enabled: Schema.Boolean,
});

/** Input of a `mcp.call` desktop channel request. */
export const DesktopMcpCallInput = Schema.Struct({
  serverId: LocalMcpServerId,
  toolName: TrimmedNonEmptyString,
  arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type DesktopMcpCallInput = typeof DesktopMcpCallInput.Type;

/**
 * Result of `mcp.call`: the local MCP `CallToolResult`, passed through verbatim
 * (`content`, `structuredContent`, `isError`). A tool-level error is a normal
 * result with `isError: true`, not a channel error.
 */
export const DesktopMcpCallResult = Schema.StructWithRest(
  Schema.Struct({
    content: Schema.Array(Schema.Unknown),
    structuredContent: Schema.optional(Schema.Unknown),
    isError: Schema.optional(Schema.Boolean),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type DesktopMcpCallResult = typeof DesktopMcpCallResult.Type;

/** JSON carried in a `progress` emit event of a `mcp.call` request. */
export const DesktopMcpProgress = Schema.Struct({
  progress: Schema.Number,
  total: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
});
export type DesktopMcpProgress = typeof DesktopMcpProgress.Type;

/** Channel error codes specific to `mcp.call` (besides the generic channel codes). */
export const DesktopMcpErrorCode = Schema.Literals([
  "MCP_SERVER_NOT_FOUND",
  "MCP_SERVER_DISABLED",
  "MCP_SERVER_UNAVAILABLE",
  "MCP_TOOL_NOT_FOUND",
  "MCP_PROTOCOL_ERROR",
  "MCP_RESULT_TOO_LARGE",
]);
export type DesktopMcpErrorCode = typeof DesktopMcpErrorCode.Type;
/** Max serialized size of one `mcp.call` result sent over the channel. */
export const DESKTOP_MCP_MAX_RESULT_BYTES = 8 * 1024 * 1024;

export interface LocalMcpBridge {
  list(): Promise<readonly LocalMcpServerView[]>;
  /** Create or replace by id. Rejects invalid configs. Restarts the server if enabled. */
  upsert(config: LocalMcpServerConfig): Promise<readonly LocalMcpServerView[]>;
  remove(id: string): Promise<readonly LocalMcpServerView[]>;
  setEnabled(id: string, enabled: boolean): Promise<readonly LocalMcpServerView[]>;
  /** Stop + start + re-list tools. */
  restart(id: string): Promise<readonly LocalMcpServerView[]>;
  /** Connect with an unsaved config, list tools, disconnect. Never throws for MCP failures. */
  probe(config: LocalMcpServerConfig): Promise<LocalMcpProbeResult>;
  onChanged(listener: (servers: readonly LocalMcpServerView[]) => void): () => void;
}
