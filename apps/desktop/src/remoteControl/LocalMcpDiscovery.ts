// @effect-diagnostics nodeBuiltinImport:off -- Read-only native configuration discovery at the desktop boundary.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  LocalMcpServerConfig,
  type LocalMcpDiscoveryApp,
  type LocalMcpDiscoveryResult,
  type LocalMcpDiscoverySkipReason,
  type LocalMcpDiscoverySource,
  type LocalMcpDiscoveredServer,
  type LocalMcpTransport,
} from "@t3tools/contracts";
import { parseNativeConfig } from "@t3tools/shared/nativeConfig";

export const MAX_MCP_DISCOVERY_FILE_BYTES = 8 * 1024 * 1024;
export interface LocalMcpDiscoveryContext {
  readonly home: string;
  readonly appData?: string;
  readonly readFile: (path: string) => Promise<string | undefined>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: () => Date;
}
const decodeConfig = Schema.decodeUnknownSync(LocalMcpServerConfig);
const apps: readonly LocalMcpDiscoveryApp[] = [
  "claude-code",
  "codex",
  "cursor",
  "vscode",
  "claude-desktop",
  "windsurf",
];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const sorted = (value: Readonly<Record<string, string>>, lower = false) =>
  Object.entries(value)
    .map(([key, item]) => [lower ? key.toLowerCase() : key, item] as const)
    .sort(([a, av], [b, bv]) => compare(a, b) || compare(av, bv));

/** Compare the Windows transports themselves, independently of their source names. */
export function transportKey(transport: LocalMcpTransport): string {
  let normalized: unknown;
  if (transport.type === "http") {
    const url = new URL(transport.url);
    if (url.hostname === "localhost") url.hostname = "127.0.0.1";
    normalized = [
      "http",
      [
        url.protocol,
        url.username,
        url.password,
        url.host,
        url.pathname.replace(/\/+$/, ""),
        url.search,
        url.hash,
      ],
      sorted(transport.headers, true),
    ];
  } else {
    normalized = [
      "stdio",
      transport.command.toLowerCase(),
      transport.args,
      transport.cwd ?? "",
      sorted(transport.env),
    ];
  }
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify(normalized))
    .digest("hex")
    .slice(0, 16);
}

export function serverId(name: string): string {
  let id = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/__+/g, "_");
  id = id.replace(/^mcp[-_]/, "") || id;
  id = id.replace(/(?:[-_]?mcp)$/, "") || id;
  if (!/^[a-z]/.test(id)) id = `m-${id}`;
  return id.slice(0, 24);
}

/** Read other apps' configs only; candidates and credentials never enter the remote catalog. */
export async function discoverLocalMcpServers(
  context: LocalMcpDiscoveryContext,
  existing: readonly LocalMcpServerConfig[],
): Promise<LocalMcpDiscoveryResult> {
  const skipped: Array<LocalMcpDiscoveryResult["skipped"][number]> = [];
  const candidates = new Map<
    string,
    { transport: LocalMcpTransport; sources: LocalMcpDiscoverySource[] }
  >();
  const join = (root: string, ...parts: string[]) =>
    (/^(?:[a-z]:[\\/]|\\\\)/i.test(root) ? NodePath.win32 : NodePath).join(root, ...parts);
  const files: Array<{
    app: LocalMcpDiscoveryApp;
    file: string;
    format: "json" | "toml";
    field: string;
  }> = [
    {
      app: "claude-code",
      file: join(context.home, ".claude.json"),
      format: "json",
      field: "mcpServers",
    },
    {
      app: "codex",
      file: join(context.home, ".codex", "config.toml"),
      format: "toml",
      field: "mcp_servers",
    },
    {
      app: "cursor",
      file: join(context.home, ".cursor", "mcp.json"),
      format: "json",
      field: "mcpServers",
    },
    ...(context.appData
      ? [
          {
            app: "vscode" as const,
            file: join(context.appData, "Code", "User", "mcp.json"),
            format: "json" as const,
            field: "servers",
          },
          {
            app: "claude-desktop" as const,
            file: join(context.appData, "Claude", "claude_desktop_config.json"),
            format: "json" as const,
            field: "mcpServers",
          },
        ]
      : []),
    {
      app: "windsurf",
      file: join(context.home, ".codeium", "windsurf", "mcp_config.json"),
      format: "json",
      field: "mcpServers",
    },
  ];
  class Skip extends Error {
    readonly reason: LocalMcpDiscoverySkipReason;
    constructor(reason: LocalMcpDiscoverySkipReason) {
      super(reason);
      this.reason = reason;
    }
  }
  const text = (value: unknown): string => {
    if (!["string", "number", "bigint", "boolean"].includes(typeof value))
      throw new Skip("invalid");
    const resolved = String(value).replace(/\$\{([^}]+)\}/g, (_match, token: string) => {
      if (token === "userHome") return context.home;
      const variable = token.startsWith("env:") ? context.env[token.slice(4)] : undefined;
      if (variable === undefined) throw new Skip("placeholder");
      return variable;
    });
    if (/\$\{/.test(resolved)) throw new Skip("placeholder");
    return resolved;
  };
  const dictionary = (value: unknown): Record<string, string> => {
    if (value === undefined) return {};
    const entries = object(value);
    if (!entries) throw new Skip("invalid");
    return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, text(value)]));
  };
  const add = (source: LocalMcpDiscoverySource, value: unknown) => {
    try {
      const entry = object(value);
      if (!entry) throw new Skip("invalid");
      if (entry.disabled === true || entry.enabled === false) throw new Skip("disabled");
      if (entry.type === "sse") throw new Skip("sse");
      let transport: LocalMcpTransport;
      if (entry.command !== undefined) {
        if (entry.type !== undefined && entry.type !== "stdio") throw new Skip("invalid");
        if (entry.args !== undefined && !Array.isArray(entry.args)) throw new Skip("invalid");
        const cwd = entry.cwd === undefined ? source.project : text(entry.cwd);
        transport = {
          type: "stdio",
          command: text(entry.command),
          args: (entry.args ?? []).map(text),
          env: dictionary(entry.env),
          ...(cwd === undefined ? {} : { cwd: text(cwd) }),
        };
      } else {
        if (entry.type !== undefined && entry.type !== "http" && entry.type !== "streamable-http")
          throw new Skip("invalid");
        const url = text(entry.url ?? entry.serverUrl);
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Skip("invalid");
        if (
          parsed.pathname.replace(/\/+$/, "").endsWith("/sse") &&
          entry.type !== "http" &&
          entry.type !== "streamable-http"
        )
          throw new Skip("sse");
        const headers = dictionary(source.app === "codex" ? entry.http_headers : entry.headers);
        if (source.app === "codex" && entry.bearer_token_env_var !== undefined) {
          const token = context.env[text(entry.bearer_token_env_var)];
          if (!token) throw new Skip("placeholder");
          for (const key of Object.keys(headers))
            if (key.toLowerCase() === "authorization") delete headers[key];
          headers.Authorization = `Bearer ${token}`;
        }
        transport = { type: "http", url, headers };
      }
      // Validate before grouping so a malformed source cannot hide a valid one.
      const config = decodeConfig({
        id: serverId(source.name),
        name: source.name,
        enabled: true,
        transport,
      });
      const key = transportKey(config.transport);
      const candidate = candidates.get(key);
      if (candidate) candidate.sources.push(source);
      else candidates.set(key, { transport: config.transport, sources: [source] });
    } catch (cause) {
      skipped.push({ source, reason: cause instanceof Skip ? cause.reason : "invalid" });
    }
  };
  for (const { app, file, format, field } of files) {
    const fileSource = { app, file, name: "" };
    try {
      const content = await context.readFile(file);
      if (content === undefined) continue;
      if (Buffer.byteLength(content, "utf8") > MAX_MCP_DISCOVERY_FILE_BYTES)
        throw new Skip("invalid");
      const document = parseNativeConfig(content.replace(/^\uFEFF/, ""), format);
      const collect = (value: unknown, project?: string) => {
        if (value === undefined) return;
        const entries = object(value);
        if (!entries) {
          skipped.push({
            source: { ...fileSource, ...(project === undefined ? {} : { project }) },
            reason: "invalid",
          });
          return;
        }
        for (const [name, entry] of Object.entries(entries)) {
          add({ app, file, name, ...(project === undefined ? {} : { project }) }, entry);
        }
      };
      collect(document[field]);
      if (app === "claude-code" && document.projects !== undefined) {
        const projects = object(document.projects);
        if (!projects) throw new Skip("invalid");
        for (const [project, value] of Object.entries(projects)) {
          const settings = object(value);
          if (!settings) skipped.push({ source: { ...fileSource, project }, reason: "invalid" });
          else collect(settings.mcpServers, project);
        }
      }
    } catch {
      // Empty source name identifies a file-level read/parse/size failure.
      skipped.push({ source: fileSource, reason: "invalid" });
    }
  }
  const existingKeys = new Map<string, string>();
  for (const config of existing) {
    try {
      const key = transportKey(config.transport);
      if (!existingKeys.has(key)) existingKeys.set(key, config.id);
    } catch {
      /* A stale existing URL must not prevent discovery. */
    }
  }
  const used = new Set(existing.map((config) => config.id));
  const servers: LocalMcpDiscoveredServer[] = [];
  for (const [key, candidate] of candidates) {
    candidate.sources.sort(
      (a, b) =>
        Number(b.project !== undefined) - Number(a.project !== undefined) ||
        apps.indexOf(a.app) - apps.indexOf(b.app) ||
        compare(a.project ?? "", b.project ?? "") ||
        compare(a.name, b.name),
    );
    const name = candidate.sources[0]!.name;
    const base = serverId(name);
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) {
      const ending = `-${suffix}`;
      id = `${base.slice(0, 24 - ending.length)}${ending}`;
    }
    try {
      const config = decodeConfig({
        id,
        name,
        enabled: true,
        transport: candidate.transport,
      });
      used.add(id);
      const addedAs = existingKeys.get(key);
      servers.push({
        key,
        config,
        sources: candidate.sources,
        ...(addedAs === undefined ? {} : { addedAs }),
      });
    } catch {
      skipped.push(...candidate.sources.map((source) => ({ source, reason: "invalid" as const })));
    }
  }
  servers.sort(
    (a, b) =>
      Number(a.addedAs !== undefined) - Number(b.addedAs !== undefined) ||
      compare(a.config.name, b.config.name) ||
      compare(a.key, b.key),
  );
  return { servers, skipped, scannedAt: context.now().toISOString() };
}
