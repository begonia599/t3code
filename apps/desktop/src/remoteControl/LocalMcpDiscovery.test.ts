// @effect-diagnostics globalDate:off -- Fixed injected scan time.
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { LocalMcpDiscoveryResult, LocalMcpServerConfig } from "@t3tools/contracts";
import { discoverLocalMcpServers, type LocalMcpDiscoveryContext } from "./LocalMcpDiscovery.ts";

const decodeDiscovery = Schema.decodeSync(LocalMcpDiscoveryResult);
const decodeConfig = Schema.decodeSync(LocalMcpServerConfig);
const home = "C:\\Users\\x";
const appData = `${home}\\AppData\\Roaming`;
const paths = {
  claude: `${home}\\.claude.json`,
  codex: `${home}\\.codex\\config.toml`,
  cursor: `${home}\\.cursor\\mcp.json`,
  vscode: `${appData}\\Code\\User\\mcp.json`,
  desktop: `${appData}\\Claude\\claude_desktop_config.json`,
  windsurf: `${home}\\.codeium\\windsurf\\mcp_config.json`,
};
const url = "http://127.0.0.1:8080/mcp";
const now = new Date("2026-11-16T00:00:00Z");
const context = (
  files: Record<string, string>,
  env: LocalMcpDiscoveryContext["env"] = {},
): LocalMcpDiscoveryContext => ({
  home,
  appData,
  env,
  now: () => now,
  readFile: async (file) => files[file],
});
const json = (mcpServers: unknown) => JSON.stringify({ mcpServers });

describe("local MCP discovery", () => {
  it("merges the five real HTTP shapes, keeps every source, and imports Claude Desktop stdio", async () => {
    const unity = { url, type: "http" };
    const stdio = {
      command: "C:\\Users\\x\\.cherrystudio\\bin\\uvx.exe",
      args: ["--from", "mcpforunityserver==10.0.0", "mcp-for-unity", "--transport", "stdio"],
      type: "stdio",
    };
    const ctx = context({
      [paths.claude]: JSON.stringify({
        projects: { "C:\\Unity": { mcpServers: { unityMCP: unity } } },
      }),
      [paths.codex]: `[mcp_servers.unityMCP]\nurl = "${url}"`,
      [paths.cursor]: json({ unityMCP: unity }),
      [paths.vscode]: JSON.stringify({ servers: { unityMCP: unity } }),
      [paths.desktop]: json({ "Unity stdio": stdio }),
      [paths.windsurf]: json({ unityMCP: { serverUrl: url } }),
    });
    const result = await discoverLocalMcpServers(ctx, []);
    expect(decodeDiscovery(result)).toEqual(result);
    expect(result.scannedAt).toBe(now.toISOString());
    expect(result.skipped).toEqual([]);
    expect(result.servers).toHaveLength(2);
    const http = result.servers.find((server) => server.config.transport.type === "http")!;
    expect(http).toMatchObject({
      key: expect.stringMatching(/^[a-f0-9]{16}$/),
      config: {
        id: "unity",
        name: "unityMCP",
        enabled: true,
        transport: { type: "http", url, headers: {} },
      },
      sources: [
        { app: "claude-code", project: "C:\\Unity" },
        { app: "codex" },
        { app: "cursor" },
        { app: "vscode" },
        { app: "windsurf" },
      ],
    });
    expect(
      result.servers.find((server) => server.config.transport.type === "stdio")?.config.transport,
    ).toEqual({ ...stdio, env: {} });
    const existing: LocalMcpServerConfig = {
      id: "already-unity",
      name: "Already here",
      enabled: false,
      transport: { type: "http", url: "http://LOCALHOST:8080/mcp/", headers: {} },
    };
    const again = await discoverLocalMcpServers(ctx, [existing]);
    expect(again.servers.at(-1)).toMatchObject({ key: http.key, addedAs: existing.id });
    expect(again.servers[0]?.addedAs).toBeUndefined();
  });

  it("accepts BOM and JSONC, expands environment/home placeholders and project cwd", async () => {
    const result = await discoverLocalMcpServers(
      context(
        {
          [paths.claude]:
            "\uFEFF" +
            JSON.stringify({
              mcpServers: { user: { command: "node", cwd: "${userHome}", env: { COUNT: 3 } } },
              projects: {
                "C:\\Unity": {
                  mcpServers: {
                    project: { command: "${env:COMMAND}", args: ["${userHome}", "${env:ARG}"] },
                  },
                },
              },
            }),
          [paths.cursor]: `\uFEFF{ // comment\n "mcpServers": { "cursor": { "url": "${url}", "type": "http", }, }, }`,
        },
        { COMMAND: "uvx", ARG: "--stdio" },
      ),
      [],
    );
    expect(result.skipped).toEqual([]);
    expect(
      result.servers.find((server) => server.config.name === "project")?.config.transport,
    ).toEqual({
      type: "stdio",
      command: "uvx",
      args: [home, "--stdio"],
      env: {},
      cwd: "C:\\Unity",
    });
    expect(
      result.servers.find((server) => server.config.name === "user")?.config.transport,
    ).toEqual({ type: "stdio", command: "node", args: [], env: { COUNT: "3" }, cwd: home });
  });

  it("reads Codex headers, bearer tokens, command settings and TOML bigint values", async () => {
    const result = await discoverLocalMcpServers(
      context(
        {
          [paths.codex]: `\uFEFF[mcp_servers.api]\nurl = "${url}"\nbearer_token_env_var = "TOKEN"\n[mcp_servers.api.http_headers]\nX-Value = "value"\n[mcp_servers.process]\ncommand = "uvx"\nargs = ["--stdio"]\ncwd = 'C:\\Unity'\n[mcp_servers.process.env]\nCOUNT = 9223372036854775806\n[mcp_servers.missing]\nurl = "http://example.com/mcp"\nbearer_token_env_var = "MISSING"\n[mcp_servers.off]\ncommand = "node"\nenabled = false`,
        },
        { TOKEN: "secret" },
      ),
      [],
    );
    expect(result.servers.find((server) => server.config.name === "api")?.config.transport).toEqual(
      { type: "http", url, headers: { "X-Value": "value", Authorization: "Bearer secret" } },
    );
    expect(
      result.servers.find((server) => server.config.name === "process")?.config.transport,
    ).toEqual({
      type: "stdio",
      command: "uvx",
      args: ["--stdio"],
      cwd: "C:\\Unity",
      env: { COUNT: "9223372036854775806" },
    });
    expect(result.skipped.map(({ source, reason }) => [source.name, reason])).toEqual([
      ["missing", "placeholder"],
      ["off", "disabled"],
    ]);
  });

  it("skips SSE, unresolved placeholders, disabled and invalid entries without hiding valid entries", async () => {
    const result = await discoverLocalMcpServers(
      context({
        [paths.cursor]: json({
          explicitSse: { type: "sse", url },
          legacySse: { url: "http://localhost:8080/sse?x=1" },
          input: { command: "node", args: ["${input:x}"] },
          workspace: { command: "node", cwd: "${workspaceFolder}" },
          missingEnv: { url: "${env:MISSING}" },
          disabled: { command: "node", disabled: true },
          off: { url, enabled: false },
          badArgs: { command: "node", args: "bad" },
          badEnv: { command: "node", env: { nested: {} } },
          badUrl: { url: "not-a-url" },
          missing: {},
          null: null,
          good: { type: "http", url: "http://localhost:8080/sse" },
          streamable: { type: "streamable-http", url: "http://localhost:8080/sse" },
        }),
      }),
      [],
    );
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.sources).toHaveLength(2);
    expect(result.skipped.map(({ source, reason }) => [source.name, reason])).toEqual([
      ["explicitSse", "sse"],
      ["legacySse", "sse"],
      ["input", "placeholder"],
      ["workspace", "placeholder"],
      ["missingEnv", "placeholder"],
      ["disabled", "disabled"],
      ["off", "disabled"],
      ["badArgs", "invalid"],
      ["badEnv", "invalid"],
      ["badUrl", "invalid"],
      ["missing", "invalid"],
      ["null", "invalid"],
    ]);
  });

  it("isolates broken, unreadable, oversized and absent files", async () => {
    const ctx = context({
      [paths.claude]: "{ broken json",
      [paths.cursor]: " ".repeat(8 * 1024 * 1024 + 1),
      [paths.vscode]: JSON.stringify({ servers: { unityMCP: { url } } }),
      [paths.windsurf]: json({ another: { url: "http://localhost:9090/mcp" } }),
    });
    const readFile = ctx.readFile;
    const result = await discoverLocalMcpServers(
      {
        ...ctx,
        readFile: (file) => {
          if (file === paths.codex) return Promise.reject(new Error("EACCES"));
          return readFile(file);
        },
      },
      [],
    );
    expect(result.servers).toHaveLength(2);
    expect(result.skipped.map(({ source, reason }) => [source.file, source.name, reason])).toEqual([
      [paths.claude, "", "invalid"],
      [paths.codex, "", "invalid"],
      [paths.cursor, "", "invalid"],
    ]);
  });

  it("normalizes headers and Windows command casing, prioritizes project sources, and reserves unique ids", async () => {
    const process = { command: "UVX.EXE", args: ["--stdio"], cwd: home, env: { Z: "z", A: "a" } };
    const result = await discoverLocalMcpServers(
      context({
        [paths.claude]: JSON.stringify({
          mcpServers: { global: process },
          projects: {
            [home]: {
              mcpServers: {
                UnityMCP: {
                  ...process,
                  command: "uvx.exe",
                  cwd: undefined,
                  env: { A: "a", Z: "z" },
                },
              },
            },
          },
        }),
        [paths.cursor]: json({
          "mcp-unity-mcp": {
            url: "http://LOCALHOST:8080/mcp/",
            headers: { "X-B": "b", "X-A": "a" },
          },
          other: { url, headers: { "x-a": "a", "x-b": "b" } },
          unity: { command: "different" },
          "123__abcdefghijklmnopqrstuvwxyz": { command: "long-id" },
          github: { command: "github" },
          mcp: { command: "mcp" },
        }),
      }),
      [
        {
          id: "unity",
          name: "existing",
          enabled: true,
          transport: { type: "stdio", command: "unrelated", args: [], env: {} },
        },
      ],
    );
    expect(result.skipped).toEqual([]);
    expect(result.servers.find((server) => server.config.name === "UnityMCP")).toMatchObject({
      config: { id: "unity-2" },
      sources: [{ project: home, name: "UnityMCP" }, { name: "global" }],
    });
    expect(result.servers.find((server) => server.config.name === "mcp-unity-mcp")).toMatchObject({
      config: { id: "unity-3" },
      sources: [{}, {}],
    });
    expect(result.servers.find((server) => server.config.name === "unity")?.config.id).toBe(
      "unity-4",
    );
    expect(result.servers.find((server) => server.config.name === "github")?.config.id).toBe(
      "github",
    );
    for (const server of result.servers) expect(decodeConfig(server.config)).toEqual(server.config);
    expect(new Set(result.servers.map((server) => server.config.id)).size).toBe(
      result.servers.length,
    );
    expect((await discoverLocalMcpServers(context({}), [])).servers).toEqual([]);
  });
});
