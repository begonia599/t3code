/**
 * Pure helpers for the "MCP servers on this PC" settings: turning a form or a
 * pasted `mcpServers` JSON snippet into a `LocalMcpServerConfig`, and back.
 *
 * @module localMcp.logic
 */
import type {
  LocalMcpDiscoveredServer,
  LocalMcpDiscoveryApp,
  LocalMcpDiscoveryResult,
  LocalMcpDiscoverySkipReason,
  LocalMcpDiscoverySource,
  LocalMcpErrorKind,
  LocalMcpServerConfig,
  LocalMcpServerStatus,
  LocalMcpServerView,
  LocalMcpTransport,
} from "@t3tools/contracts";

const ID_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;
const MAX_ID_LENGTH = 24;

export type LocalMcpKind = "stdio" | "http";

/** Editable form state. Multi-value fields are kept as text, one entry per line. */
export interface LocalMcpDraft {
  readonly id: string;
  /** False while the id still follows the name automatically. */
  readonly idEdited: boolean;
  readonly name: string;
  readonly kind: LocalMcpKind;
  readonly command: string;
  readonly args: string;
  readonly cwd: string;
  readonly env: string;
  readonly url: string;
  readonly headers: string;
  readonly enabled: boolean;
}

export type LocalMcpDraftField = "id" | "name" | "command" | "env" | "url" | "headers";
/** `message` is English source text for `t()`; `{line}` in it is replaced with `line`. */
export interface LocalMcpFieldError {
  readonly message: string;
  readonly line?: number;
}
export type LocalMcpDraftErrors = Partial<Record<LocalMcpDraftField, LocalMcpFieldError>>;

export function emptyLocalMcpDraft(): LocalMcpDraft {
  return {
    id: "",
    idEdited: false,
    name: "",
    kind: "stdio",
    command: "",
    args: "",
    cwd: "",
    env: "",
    url: "",
    headers: "",
    enabled: true,
  };
}

/** `Unity MCP` → `unity-mcp`; always a valid id or "" for names with no usable characters. */
export function slugifyLocalMcpId(name: string): string {
  let slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug === "") return "";
  if (!/^[a-z]/.test(slug)) slug = `mcp-${slug}`;
  return slug.slice(0, MAX_ID_LENGTH).replace(/-+$/, "");
}

/** Appends `-2`, `-3`, … until the id is free. */
export function uniqueLocalMcpId(base: string, taken: ReadonlySet<string>): string {
  const root = base === "" ? "mcp" : base;
  if (!taken.has(root)) return root;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${root.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function withDraftName(draft: LocalMcpDraft, name: string): LocalMcpDraft {
  return draft.idEdited ? { ...draft, name } : { ...draft, name, id: slugifyLocalMcpId(name) };
}

export function draftFromConfig(config: LocalMcpServerConfig): LocalMcpDraft {
  const transport = config.transport;
  return {
    ...emptyLocalMcpDraft(),
    id: config.id,
    idEdited: true,
    name: config.name,
    enabled: config.enabled,
    ...(transport.type === "stdio"
      ? {
          kind: "stdio" as const,
          command: transport.command,
          args: transport.args.join("\n"),
          cwd: transport.cwd ?? "",
          env: formatPairs(transport.env, "="),
        }
      : {
          kind: "http" as const,
          url: transport.url,
          headers: formatPairs(transport.headers, ": "),
        }),
  };
}

function formatPairs(record: Readonly<Record<string, string>>, separator: string): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}${separator}${value}`)
    .join("\n");
}

/** One argument per line; blank lines dropped; surrounding whitespace kept inside the line. */
export function parseArgsText(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

type PairsResult =
  | { readonly ok: true; readonly value: Record<string, string> }
  | { readonly ok: false; readonly line: number };

/** `KEY=VALUE` (env) or `Name: value` (headers) per line. Reports the first bad line, 1-based. */
export function parsePairsText(text: string, separator: "=" | ":"): PairsResult {
  const value: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf(separator);
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (key === "" || /\s/.test(key)) return { ok: false, line: index + 1 };
    value[key] = line.slice(at + 1).trim();
  }
  return { ok: true, value };
}

function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Validates a draft. `takenIds` are ids of other servers (exclude the one being
 * edited). Error strings are English source text for `t()`.
 */
export function draftToConfig(
  draft: LocalMcpDraft,
  takenIds: ReadonlySet<string>,
):
  | { readonly ok: true; readonly config: LocalMcpServerConfig }
  | { readonly ok: false; readonly errors: LocalMcpDraftErrors } {
  const errors: { -readonly [K in LocalMcpDraftField]?: LocalMcpFieldError } = {};
  const fail = (field: LocalMcpDraftField, message: string, line?: number) => {
    errors[field] = line === undefined ? { message } : { message, line };
  };
  const name = draft.name.trim();
  const id = draft.id.trim();
  if (name === "") fail("name", "Enter a name.");
  if (id === "") fail("id", "Enter a tool prefix.");
  else if (!ID_PATTERN.test(id) || id.includes("__"))
    fail("id", "Use 1–24 lowercase letters, digits, - or _, starting with a letter.");
  else if (takenIds.has(id)) fail("id", "Another MCP server already uses this prefix.");

  let transport: LocalMcpServerConfig["transport"] | null = null;
  if (draft.kind === "stdio") {
    const command = draft.command.trim();
    const env = parsePairsText(draft.env, "=");
    if (command === "") fail("command", "Enter the command that starts the server.");
    if (!env.ok) fail("env", "Line {line}: use NAME=value.", env.line);
    if (command !== "" && env.ok) {
      const cwd = draft.cwd.trim();
      transport = {
        type: "stdio",
        command,
        args: parseArgsText(draft.args),
        env: env.value,
        ...(cwd === "" ? {} : { cwd }),
      };
    }
  } else {
    const url = draft.url.trim();
    const headers = parsePairsText(draft.headers, ":");
    if (!isHttpUrl(url)) fail("url", "Enter an http:// or https:// address.");
    if (!headers.ok) fail("headers", "Line {line}: use Name: value.", headers.line);
    if (isHttpUrl(url) && headers.ok) transport = { type: "http", url, headers: headers.value };
  }

  if (Object.keys(errors).length > 0 || transport === null) return { ok: false, errors };
  return { ok: true, config: { id, name, enabled: draft.enabled, transport } };
}

type PasteResult =
  | { readonly ok: true; readonly drafts: readonly LocalMcpDraft[] }
  | { readonly ok: false; readonly error: string };

function parseJsonLoosely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Docs often show JSONC: strip line comments outside strings and trailing commas.
    const stripped = text
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*/g, (_, str: string | undefined) => str ?? "")
      .replace(/,\s*([}\]])/g, "$1");
    try {
      return JSON.parse(stripped);
    } catch {
      // A bare `"name": { ... }` entry copied out of a larger file.
      return JSON.parse(`{${stripped.trim().replace(/,$/, "")}}`);
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const looksLikeServer = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) && (typeof value.command === "string" || typeof value.url === "string");

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "string" || typeof entry === "number" ? [[key, String(entry)]] : [],
    ),
  );
}

function draftFromPasted(name: string, server: Record<string, unknown>): LocalMcpDraft | string {
  const base = withDraftName(emptyLocalMcpDraft(), name);
  if (typeof server.command === "string") {
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return {
      ...base,
      kind: "stdio",
      command: server.command,
      args: args.join("\n"),
      cwd: typeof server.cwd === "string" ? server.cwd : "",
      env: formatPairs(stringRecord(server.env), "="),
    };
  }
  const type = typeof server.type === "string" ? server.type.toLowerCase() : "http";
  if (type === "sse") {
    return "This server uses the older SSE transport. Use its streamable HTTP address instead.";
  }
  return {
    ...base,
    kind: "http",
    url: String(server.url),
    headers: formatPairs(stringRecord(server.headers), ": "),
  };
}

/**
 * Accepts the snippets MCP READMEs show: `{"mcpServers": {...}}`, VS Code's
 * `{"servers": {...}}`, a bare `{name: server}` map, or one server object.
 */
export function parsePastedLocalMcpConfig(text: string): PasteResult {
  let parsed: unknown;
  try {
    parsed = parseJsonLoosely(text.trim());
  } catch {
    return { ok: false, error: "This isn't valid JSON." };
  }
  if (!isRecord(parsed)) return { ok: false, error: "This isn't an MCP server config." };
  const container = isRecord(parsed.mcpServers)
    ? parsed.mcpServers
    : isRecord(parsed.servers)
      ? parsed.servers
      : looksLikeServer(parsed)
        ? { [typeof parsed.name === "string" ? parsed.name : "MCP server"]: parsed }
        : parsed;
  const drafts: LocalMcpDraft[] = [];
  let lastError: string | null = null;
  for (const [name, server] of Object.entries(container)) {
    if (!looksLikeServer(server)) continue;
    const draft = draftFromPasted(name, server);
    if (typeof draft === "string") lastError = draft;
    else drafts.push(draft);
  }
  if (drafts.length === 0) {
    return { ok: false, error: lastError ?? "No MCP server with a command or url was found." };
  }
  return { ok: true, drafts };
}

/** Short, single-line description of how the server is started. */
/** One line for an argv; parts with spaces or quotes are quoted, backslashes kept as typed. */
export function formatCommandLine(command: string, args: readonly string[]): string {
  const quote = (part: string) =>
    part === "" || /[\s"]/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part;
  return [command, ...args].map(quote).join(" ");
}

export function describeLocalMcpTransport(config: LocalMcpServerConfig): string {
  const transport = config.transport;
  if (transport.type === "http") return transport.url;
  return formatCommandLine(transport.command, transport.args);
}

export interface LocalMcpStatusPresentation {
  readonly label: string;
  readonly dotClassName: string;
  readonly pulse: boolean;
  readonly tone: "success" | "info" | "error" | "muted";
}

export function localMcpStatusPresentation(
  status: LocalMcpServerStatus,
  enabled: boolean,
): LocalMcpStatusPresentation {
  if (!enabled) {
    return {
      label: "Turned off",
      dotClassName: "bg-muted-foreground/30",
      pulse: false,
      tone: "muted",
    };
  }
  switch (status) {
    case "running":
      return { label: "Ready", dotClassName: "bg-success", pulse: false, tone: "success" };
    case "starting":
      return { label: "Starting…", dotClassName: "bg-info", pulse: true, tone: "info" };
    case "failed":
      return { label: "Not running", dotClassName: "bg-destructive", pulse: false, tone: "error" };
    case "stopped":
      return {
        label: "Stopped",
        dotClassName: "bg-muted-foreground/45",
        pulse: false,
        tone: "muted",
      };
  }
}

/** Tool count label source text, e.g. "12 tools". */
export function toolCountText(view: LocalMcpServerView): { text: string; count: number } {
  const count = view.tools.length;
  return { text: count === 1 ? "1 tool" : "{count} tools", count };
}

/**
 * An MCP address as shown in error text: scheme, host, port and path only.
 * Query strings and user info can carry tokens, so they never reach the screen.
 */
export function displayMcpAddress(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${parsed.protocol}//${parsed.host}${path}`;
  } catch {
    return url;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** English source text for `t()`, plus the address that fills `{address}`. */
export interface LocalMcpErrorText {
  readonly source: string;
  readonly address?: string;
}

/**
 * What went wrong, in plain words. The raw detail from the desktop stays
 * available underneath for troubleshooting. Pass the server's transport so an
 * unreachable address can be named — and so the Unity hint only shows for
 * addresses on this PC, where Unity MCP actually listens.
 */
export function localMcpErrorExplanation(
  kind: LocalMcpErrorKind,
  transport?: LocalMcpTransport,
): LocalMcpErrorText {
  switch (kind) {
    case "unreachable": {
      if (transport?.type !== "http") {
        return {
          source: "Nothing is answering. Open the program that provides this server first.",
        };
      }
      const address = displayMcpAddress(transport.url);
      let local = false;
      try {
        local = isLoopbackHost(new URL(transport.url).hostname);
      } catch {
        local = false;
      }
      return local
        ? {
            source:
              "Can't reach {address} — nothing is running at this address. If it's Unity MCP, open Unity and start its MCP server first.",
            address,
          }
        : {
            source: "Can't reach {address}. Check the address and this PC's network connection.",
            address,
          };
    }
    case "http":
      return {
        source: "The address answered with an error. Check the URL and any token in the headers.",
      };
    case "spawn":
      return {
        source:
          "The command couldn't start. Check that the program is installed and the command is spelled right.",
      };
    case "closed":
      return { source: "The connection dropped. The server may be restarting or may have quit." };
    case "timeout":
      return { source: "The server didn't respond in time." };
    case "protocol":
      return {
        source:
          "Something answered, but not as an MCP server. Check the address path (often /mcp) or the command.",
      };
  }
}

const DISCOVERY_APP_LABELS: Readonly<Record<LocalMcpDiscoveryApp, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  vscode: "VS Code",
  "claude-desktop": "Claude Desktop",
  windsurf: "Windsurf",
};

/** Every app the desktop scans, in display order. */
export const DISCOVERY_APPS = Object.keys(DISCOVERY_APP_LABELS) as readonly LocalMcpDiscoveryApp[];

export function discoveryAppLabel(app: LocalMcpDiscoveryApp): string {
  return DISCOVERY_APP_LABELS[app];
}

/** App names a discovered server came from, deduplicated, in source order. */
export function discoverySourceApps(sources: readonly LocalMcpDiscoverySource[]): string[] {
  return [...new Set(sources.map((source) => discoveryAppLabel(source.app)))];
}

/** Last path segment of a Windows or POSIX path (project folder name). */
export function pathBaseName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? path
  );
}

/** Discovered servers that aren't added yet, minus ones added during this session. */
export function pendingDiscoveredServers(
  result: LocalMcpDiscoveryResult,
  addedKeys: ReadonlySet<string>,
): LocalMcpDiscoveredServer[] {
  return result.servers.filter((server) => !server.addedAs && !addedKeys.has(server.key));
}

export interface LocalMcpSkippedNote {
  readonly app: string;
  /** Empty when a whole config file couldn't be read. */
  readonly name: string;
  readonly reason: LocalMcpDiscoverySkipReason;
}

/**
 * Entries worth explaining: drops ones whose name also turned up as a usable
 * server elsewhere (e.g. disabled in Codex but working in Cursor) and repeats.
 */
export function skippedDiscoveryNotes(result: LocalMcpDiscoveryResult): LocalMcpSkippedNote[] {
  const usable = new Set(
    result.servers.flatMap((server) => server.sources.map((source) => source.name.toLowerCase())),
  );
  const seen = new Set<string>();
  const notes: LocalMcpSkippedNote[] = [];
  for (const { source, reason } of result.skipped) {
    if (source.name !== "" && usable.has(source.name.toLowerCase())) continue;
    const note = { app: discoveryAppLabel(source.app), name: source.name, reason };
    const key = `${note.app}\u0000${note.name.toLowerCase()}\u0000${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push(note);
  }
  return notes;
}

/** Why one entry couldn't be added (English source text for `t()`). */
export function skippedReasonText(reason: LocalMcpDiscoverySkipReason): string {
  switch (reason) {
    case "sse":
      return "uses the older SSE transport";
    case "placeholder":
      return "needs values only that app can fill in";
    case "disabled":
      return "turned off there";
    case "invalid":
      return "config not recognized";
  }
}
