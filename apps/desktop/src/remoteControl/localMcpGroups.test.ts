import { describe, expect, it } from "@effect/vitest";
import type {
  LocalMcpDiscoveredServer,
  LocalMcpServerView,
  LocalMcpTransport,
} from "@t3tools/contracts";
import { groupLocalMcpDiscovery, groupLocalMcpViews, serverId } from "./localMcpGroups.ts";

const http: LocalMcpTransport = {
  type: "http",
  url: "http://127.0.0.1:8080/mcp",
  headers: {},
};
const unity: LocalMcpTransport = {
  type: "stdio",
  command: "C:\\Users\\34866\\.cherrystudio\\bin\\uvx.exe",
  args: ["--from", "mcpforunityserver==10.0.0", "mcp-for-unity", "--transport", "stdio"],
  env: {},
};
const stdio: LocalMcpTransport = { type: "stdio", command: "node", args: [], env: {} };
const view = (
  name: string,
  transport: LocalMcpTransport,
  overrides: Partial<LocalMcpServerView> = {},
): LocalMcpServerView => ({
  config: { id: serverId(name), name, enabled: true, transport },
  status: "running",
  tools: [],
  ...overrides,
});
const candidate = (name: string, transport: LocalMcpTransport): LocalMcpDiscoveredServer => ({
  key: name,
  config: view(name, transport).config,
  sources: [{ app: "claude-desktop", name, file: "config.json" }],
});

describe("local MCP service groups", () => {
  it("groups the real Unity HTTP and stdio configs, preferring HTTP regardless of candidate order", () => {
    const servers = [candidate("unityMCP", unity), candidate("UnityMCP", http)];
    const result = groupLocalMcpDiscovery(servers, []);
    expect(result.map((server) => server.preferred)).toEqual([false, true]);
    for (const server of result) {
      expect(server.group).toEqual({ key: "product:mcp-for-unity", label: "Unity" });
      expect(server.duplicateOf).toBeUndefined();
    }
    expect(groupLocalMcpDiscovery(servers, [])).toEqual(result);
    expect(groupLocalMcpDiscovery(servers.toReversed(), [])[0]?.group).toEqual(result[0]?.group);
    expect(servers.every((server) => server.group === undefined)).toBe(true);
  });

  it.each([
    ["C:\\Tools\\MCP-FOR-UNITY-SERVER.EXE", []],
    ["uvx", ["C:\\packages\\MCPFORUNITYSERVER==10.0.0"]],
    ["node", ["/packages/MCP-FOR-UNITY@10.0.0"]],
    ["uvx", ["mcp-for-unity-server.exe@10.0.0"]],
  ])("recognizes Unity executable and version suffixes: %s %j", (command, args) => {
    const result = groupLocalMcpDiscovery(
      [candidate("one", { type: "stdio", command, args, env: {} }), candidate("two", unity)],
      [],
    );
    expect(result[0]?.group?.label).toBe("Unity");
    expect(result.map((server) => server.preferred)).toEqual([true, false]);
  });

  it("does not group same-name stdio filesystem servers for different directories", () => {
    const result = groupLocalMcpDiscovery(
      ["C:\\first", "C:\\second"].map((directory) =>
        candidate("filesystem", { ...stdio, args: ["filesystem", directory] }),
      ),
      [],
    );
    expect(
      result.every((server) => server.group === undefined && server.preferred === undefined),
    ).toBe(true);
  });

  it("does not group same-name HTTP servers with different addresses", () => {
    const result = groupLocalMcpViews([
      view("github", http),
      view("githubMCP", { ...http, url: "http://127.0.0.1:9090/mcp" }),
    ]);
    expect(result.every((server) => server.group === undefined)).toBe(true);
  });

  it("groups known products across HTTP endpoints even when their configured names differ", () => {
    const result = groupLocalMcpViews([
      view("editor-one", http, { serverName: "mcp-for-unity-server" }),
      view(
        "editor-two",
        { ...http, url: "http://127.0.0.1:9090/mcp" },
        { serverName: "MCP-FOR-UNITY-SERVER" },
      ),
    ]);
    expect(result[1]).toMatchObject({
      group: { key: "product:mcp-for-unity", label: "Unity" },
      duplicateOf: "editor-one",
    });
  });

  it("groups normalized HTTP/stdio names and uses all source aliases transitively", () => {
    const first = candidate("GithubMCP", stdio);
    const second = {
      ...candidate("mcp-github", http),
      sources: [
        { app: "cursor" as const, name: "mcp-github", file: "a.json" },
        { app: "codex" as const, name: "alias", file: "b.toml" },
      ],
    };
    const servers = [first, second, candidate("alias", stdio)];
    const result = groupLocalMcpDiscovery(servers, []);
    expect(result.map((server) => server.preferred)).toEqual([false, true, false]);
    expect(result.map((server) => server.group)).toEqual(
      Array.from({ length: 3 }, () => ({ key: "name:alias", label: "mcp-github" })),
    );
  });

  it("marks every candidate as a duplicate of the enabled configured primary", () => {
    const servers = [candidate("UnityMCP", http), candidate("unityMCP", unity)];
    const existing = view("unity", http, {
      serverName: "mcp-for-unity-server",
      serverVersion: "3.4.11",
      toolsUpdatedAt: "2026-11-17T00:00:00Z",
    });
    const result = groupLocalMcpDiscovery(
      [{ ...servers[0]!, addedAs: "unity" }, servers[1]!],
      [existing],
    );
    expect(result.map((server) => [server.preferred, server.duplicateOf])).toEqual([
      [false, "unity"],
      [false, "unity"],
    ]);
    expect(result.every((server) => server.group?.label === "Unity")).toBe(true);
  });

  it("counts an added candidate and its configured service as one member", () => {
    const existing = view("unity", http, { serverName: "mcp-for-unity-server" });
    const server = { ...candidate("unityMCP", http), addedAs: "unity" };
    expect(groupLocalMcpDiscovery([server], [existing])).toEqual([server]);
  });

  it("uses added aliases to link an existing member and prefers only unadded candidates", () => {
    const existing = view("renamed", http);
    const added = { ...candidate("github", http), addedAs: existing.config.id };
    const servers = [added, candidate("githubMCP", stdio)];
    expect(groupLocalMcpDiscovery(servers, [existing]).map((server) => server.duplicateOf)).toEqual(
      ["renamed", "renamed"],
    );
    const disabled = { ...existing, config: { ...existing.config, enabled: false } };
    const result = groupLocalMcpDiscovery(servers, [disabled]);
    expect(result.map((server) => server.preferred)).toEqual([false, true]);
    expect(result.every((server) => server.duplicateOf === undefined)).toBe(true);
  });

  it("prefers the first HTTP candidate in the existing discovery order", () => {
    const result = groupLocalMcpDiscovery(
      [candidate("unityMCP", unity), candidate("UnityMCP", http), candidate("unity", http)],
      [],
    );
    expect(result.map((server) => server.preferred)).toEqual([false, true, false]);
  });

  it("selects configured primaries by successful tools listing, then HTTP, then config order", () => {
    const stdioFirst = view("unity-stdio-first", unity);
    const stdioTools = view("unity-stdio-tools", unity, {
      status: "failed",
      toolsUpdatedAt: "2026-11-17T00:00:00Z",
    });
    const httpFirst = view("unity-http-first", http, { serverName: "mcp-for-unity-server" });
    const httpSecond = view("unity-http-second", httpFirst.config.transport, {
      serverName: "mcp-for-unity-server",
    });
    const disabled = view("disabled", unity, {
      config: { ...view("disabled", unity).config, enabled: false },
      toolsUpdatedAt: "2026-11-17T00:00:00Z",
    });
    const views = [stdioFirst, httpFirst, stdioTools, httpSecond, disabled];
    const result = groupLocalMcpViews(views);
    expect(result.map((server) => server.duplicateOf)).toEqual([
      "unity-stdio-tools",
      "unity-stdio-tools",
      undefined,
      "unity-stdio-tools",
      "unity-stdio-tools",
    ]);
    const listedHttp = { ...httpFirst, toolsUpdatedAt: "2026-11-17T00:00:00Z" };
    expect(groupLocalMcpViews([stdioTools, listedHttp])[0]?.duplicateOf).toBe(httpFirst.config.id);
    expect(groupLocalMcpViews([stdioFirst, httpFirst, httpSecond])[2]?.duplicateOf).toBe(
      httpFirst.config.id,
    );
    expect(groupLocalMcpViews([stdioFirst, view("next", unity)])[1]?.duplicateOf).toBe(
      stdioFirst.config.id,
    );
    const candidates = groupLocalMcpDiscovery([candidate("unityMCP", unity)], views);
    expect(candidates[0]).toMatchObject({ preferred: false, duplicateOf: "unity-stdio-tools" });
  });

  it("groups configured HTTP/stdio members by case-insensitive serverName", () => {
    const views = [
      view("first", stdio, { serverName: "Example-service" }),
      view("second", http, { serverName: "EXAMPLE-SERVICE" }),
    ];
    const result = groupLocalMcpViews(views);
    expect(result[0]).toMatchObject({
      group: { key: "name:first", label: "second" },
      duplicateOf: "second",
    });
    expect(result[1]?.duplicateOf).toBeUndefined();
    expect(groupLocalMcpViews(result)).toEqual(result);
  });

  it("clears primary annotations when all members are disabled, and groups when members are removed", () => {
    const grouped = groupLocalMcpViews([view("one", unity), view("two", unity)]);
    const result = groupLocalMcpViews(
      grouped.map((server) => ({
        ...server,
        config: { ...server.config, enabled: false },
      })),
    );
    expect(
      result.every((server) => server.group?.label === "Unity" && server.duplicateOf === undefined),
    ).toBe(true);
    expect(groupLocalMcpViews([grouped[1]!])[0]?.group).toBeUndefined();
    expect(groupLocalMcpViews([grouped[1]!])[0]?.duplicateOf).toBeUndefined();
  });
});
