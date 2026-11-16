import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Version advertised in `DesktopChannelCapabilities.mcp.version`. */
export const DESKTOP_MCP_VERSION = "1";
/** Desktop channel request kind for one forwarded `tools/call`. */
export const DESKTOP_MCP_CALL_KIND = "mcp.call";
export const DESKTOP_MCP_LIST_KIND = "mcp.list";
export const DESKTOP_MCP_ADD_KIND = "mcp.add";
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

/**
 * Why a local MCP could not be reached or failed, so the UI can explain it in plain words.
 * - `unreachable`: nothing listening at the HTTP address (connection refused, DNS, fetch failed)
 * - `http`: the address answered with a non-success HTTP status (401/404/500…)
 * - `spawn`: the stdio command could not be started (not found, exited during startup)
 * - `closed`: the connection dropped after it was up (server restarted or crashed)
 * - `timeout`: connect or tools/list did not finish in time
 * - `protocol`: the server answered but not as a valid MCP server
 */
export const LocalMcpErrorKind = Schema.Literals([
  "unreachable",
  "http",
  "spawn",
  "closed",
  "timeout",
  "protocol",
]);
export type LocalMcpErrorKind = typeof LocalMcpErrorKind.Type;

/** Config + live state, for the settings UI. */
export const LocalMcpServerView = Schema.Struct({
  config: LocalMcpServerConfig,
  status: LocalMcpServerStatus,
  /** Last start/list error, raw detail (shown under the plain-words explanation). */
  error: Schema.optional(Schema.String),
  errorKind: Schema.optional(LocalMcpErrorKind),
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
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.String,
    errorKind: Schema.optional(LocalMcpErrorKind),
  }),
]);
export type LocalMcpProbeResult = typeof LocalMcpProbeResult.Type;

/** Apps whose MCP config files the desktop scans on this PC. */
export const LocalMcpDiscoveryApp = Schema.Literals([
  "claude-code",
  "codex",
  "cursor",
  "vscode",
  "claude-desktop",
  "windsurf",
]);
export type LocalMcpDiscoveryApp = typeof LocalMcpDiscoveryApp.Type;

/** One place a discovered MCP config was found. */
export const LocalMcpDiscoverySource = Schema.Struct({
  app: LocalMcpDiscoveryApp,
  /** Absolute Windows path of the config file. */
  file: Schema.String,
  /** Server name as written in that file (e.g. `unityMCP`). */
  name: Schema.String,
  /** Project path for project-scoped entries (Claude Code `projects.*`), else omitted. */
  project: Schema.optional(Schema.String),
});
export type LocalMcpDiscoverySource = typeof LocalMcpDiscoverySource.Type;

/**
 * An MCP server configured in another app on this PC, deduplicated by normalized transport.
 * Stays on the desktop (env/header values included); never sent to the server.
 */
export const LocalMcpDiscoveredServer = Schema.Struct({
  /** Stable across scans: hash of the normalized transport. */
  key: TrimmedNonEmptyString,
  /** Ready to save: `enabled: true`, id unique against current local configs. */
  config: LocalMcpServerConfig,
  /** Every file/entry that produced this transport, most specific first. */
  sources: Schema.Array(LocalMcpDiscoverySource),
  /** Id of the existing local config with the same transport, if already added. */
  addedAs: Schema.optional(LocalMcpServerId),
});
export type LocalMcpDiscoveredServer = typeof LocalMcpDiscoveredServer.Type;

export const LocalMcpDiscoverySkipReason = Schema.Literals([
  /** Legacy SSE transport (only stdio and Streamable HTTP are supported). */
  "sse",
  /** Uses `${input:…}`-style placeholders that only the original app can fill in. */
  "placeholder",
  /** Disabled in the original app. */
  "disabled",
  /** Anything else we could not turn into a valid config. */
  "invalid",
]);
export type LocalMcpDiscoverySkipReason = typeof LocalMcpDiscoverySkipReason.Type;

export const LocalMcpDiscoveryResult = Schema.Struct({
  servers: Schema.Array(LocalMcpDiscoveredServer),
  skipped: Schema.Array(
    Schema.Struct({ source: LocalMcpDiscoverySource, reason: LocalMcpDiscoverySkipReason }),
  ),
  /** ISO time of the scan. */
  scannedAt: Schema.String,
});
export type LocalMcpDiscoveryResult = typeof LocalMcpDiscoveryResult.Type;

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

/** Agent-facing summaries intentionally exclude raw config and error text. */
export const DesktopMcpListInput = Schema.Struct({});
export type DesktopMcpListInput = typeof DesktopMcpListInput.Type;
export const DesktopMcpListResult = Schema.Struct({
  servers: Schema.Array(
    Schema.Struct({
      id: LocalMcpServerId,
      name: Schema.String,
      enabled: Schema.Boolean,
      status: LocalMcpServerStatus,
      errorKind: Schema.optional(LocalMcpErrorKind),
      toolCount: NonNegativeInt,
    }),
  ),
  candidates: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      name: Schema.String,
      apps: Schema.Array(LocalMcpDiscoveryApp),
      transport: Schema.Union([
        Schema.Struct({ type: Schema.Literal("stdio"), command: Schema.String }),
        Schema.Struct({ type: Schema.Literal("http"), origin: Schema.String }),
      ]),
      envNames: Schema.optional(Schema.Array(Schema.String)),
      headerNames: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  skipped: NonNegativeInt,
});
export type DesktopMcpListResult = typeof DesktopMcpListResult.Type;
export const LocalMcpAgentConfig = Schema.Struct({
  id: Schema.optional(LocalMcpServerId),
  name: TrimmedNonEmptyString,
  transport: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("stdio"),
      command: TrimmedNonEmptyString,
      args: Schema.Array(Schema.String),
      cwd: Schema.optional(Schema.String),
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
    Schema.Struct({
      type: Schema.Literal("http"),
      url: Schema.String.check(
        Schema.makeFilter((value: string) => {
          try {
            const url = new URL(value);
            return url.protocol === "http:" || url.protocol === "https:";
          } catch {
            return false;
          }
        }),
      ),
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ]),
});
export const DesktopMcpAddInput = Schema.Union([
  Schema.Struct({ key: TrimmedNonEmptyString }),
  Schema.Struct({ config: LocalMcpAgentConfig }),
]);
export type DesktopMcpAddInput = typeof DesktopMcpAddInput.Type;
export const DesktopMcpAddResult = Schema.Struct({
  id: LocalMcpServerId,
  name: Schema.String,
  status: LocalMcpServerStatus,
  errorKind: Schema.optional(LocalMcpErrorKind),
  toolCount: NonNegativeInt,
  toolPrefix: Schema.String,
});
export type DesktopMcpAddResult = typeof DesktopMcpAddResult.Type;
export const LocalMcpAddProposal = Schema.Struct({
  proposalId: Schema.String,
  environmentId: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  provider: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
  origin: Schema.Literals(["discovered", "agent"]),
  sources: Schema.optional(Schema.Array(LocalMcpDiscoverySource)),
  name: Schema.String,
  id: LocalMcpServerId,
  transport: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("stdio"),
      command: Schema.String,
      args: Schema.Array(Schema.String),
      cwd: Schema.optional(Schema.String),
      envNames: Schema.Array(Schema.String),
      /** Only on agent-written proposals: the agent chose these values, so the user should see them. */
      env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
    Schema.Struct({
      type: Schema.Literal("http"),
      url: Schema.String,
      headerNames: Schema.Array(Schema.String),
      /** Only on agent-written proposals, as with `env`. */
      headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ]),
  requestedAt: Schema.String,
  expiresAt: Schema.String,
});
export type LocalMcpAddProposal = typeof LocalMcpAddProposal.Type;
export const LocalMcpAddDecision = Schema.Struct({
  proposalId: Schema.String,
  decision: Schema.Literals(["add", "deny"]),
});
export type LocalMcpAddDecision = typeof LocalMcpAddDecision.Type;

export interface LocalMcpBridge {
  listAddProposals(): Promise<readonly LocalMcpAddProposal[]>;
  resolveAddProposal(decision: LocalMcpAddDecision): Promise<void>;
  onAddProposalsChanged(listener: (proposals: readonly LocalMcpAddProposal[]) => void): () => void;
  list(): Promise<readonly LocalMcpServerView[]>;
  /** Create or replace by id. Rejects invalid configs. Restarts the server if enabled. */
  upsert(config: LocalMcpServerConfig): Promise<readonly LocalMcpServerView[]>;
  remove(id: string): Promise<readonly LocalMcpServerView[]>;
  setEnabled(id: string, enabled: boolean): Promise<readonly LocalMcpServerView[]>;
  /** Stop + start + re-list tools. */
  restart(id: string): Promise<readonly LocalMcpServerView[]>;
  /** Connect with an unsaved config, list tools, disconnect. Never throws for MCP failures. */
  probe(config: LocalMcpServerConfig): Promise<LocalMcpProbeResult>;
  /** Scan other apps' MCP config files on this PC. Read-only; never throws for bad files. */
  discover(): Promise<LocalMcpDiscoveryResult>;
  onChanged(listener: (servers: readonly LocalMcpServerView[]) => void): () => void;
}
