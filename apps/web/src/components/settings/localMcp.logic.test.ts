import type {
  LocalMcpDiscoveredServer,
  LocalMcpDiscoveryResult,
  LocalMcpServerConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeLocalMcpTransport,
  discoverySourceApps,
  draftFromConfig,
  draftToConfig,
  emptyLocalMcpDraft,
  localMcpErrorExplanation,
  localMcpStatusPresentation,
  parsePairsText,
  parsePastedLocalMcpConfig,
  pathBaseName,
  pendingDiscoveredServers,
  skippedDiscoveryNotes,
  slugifyLocalMcpId,
  uniqueLocalMcpId,
  withDraftName,
} from "./localMcp.logic";

const none = new Set<string>();

describe("slugifyLocalMcpId", () => {
  it("turns names into valid prefixes", () => {
    expect(slugifyLocalMcpId("Unity MCP")).toBe("unity-mcp");
    expect(slugifyLocalMcpId("  Blender__Bridge ")).toBe("blender-bridge");
    expect(slugifyLocalMcpId("3D tools")).toBe("mcp-3d-tools");
    expect(slugifyLocalMcpId("工具")).toBe("");
    expect(slugifyLocalMcpId("a".repeat(40))).toHaveLength(24);
  });
});

describe("uniqueLocalMcpId", () => {
  it("appends a counter when taken and stays within 24 chars", () => {
    expect(uniqueLocalMcpId("unity", none)).toBe("unity");
    expect(uniqueLocalMcpId("unity", new Set(["unity", "unity-2"]))).toBe("unity-3");
    expect(uniqueLocalMcpId("", none)).toBe("mcp");
    const long = "a".repeat(24);
    expect(uniqueLocalMcpId(long, new Set([long]))).toBe(`${"a".repeat(22)}-2`);
  });
});

describe("withDraftName", () => {
  it("follows the name until the prefix is edited", () => {
    const named = withDraftName(emptyLocalMcpDraft(), "Unity");
    expect(named.id).toBe("unity");
    const edited = withDraftName({ ...named, id: "u", idEdited: true }, "Unity Editor");
    expect(edited.id).toBe("u");
  });
});

describe("parsePairsText", () => {
  it("parses pairs and reports the first bad line", () => {
    expect(parsePairsText("A=1\n\n B = two=2 ", "=")).toEqual({
      ok: true,
      value: { A: "1", B: "two=2" },
    });
    expect(parsePairsText("Authorization: Bearer x", ":")).toEqual({
      ok: true,
      value: { Authorization: "Bearer x" },
    });
    expect(parsePairsText("A=1\nnope", "=")).toEqual({ ok: false, line: 2 });
    expect(parsePairsText("=1", "=")).toEqual({ ok: false, line: 1 });
  });
});

describe("draftToConfig", () => {
  const stdio = {
    ...withDraftName(emptyLocalMcpDraft(), "Unity"),
    command: " uv ",
    args: "run\n\n--directory\nC:\\Unity Mcp\\src\nserver.py\n",
    env: "PYTHONUTF8=1",
  };

  it("builds a stdio config", () => {
    expect(draftToConfig(stdio, none)).toEqual({
      ok: true,
      config: {
        id: "unity",
        name: "Unity",
        enabled: true,
        transport: {
          type: "stdio",
          command: "uv",
          args: ["run", "--directory", "C:\\Unity Mcp\\src", "server.py"],
          env: { PYTHONUTF8: "1" },
        },
      },
    });
  });

  it("reports field errors", () => {
    const result = draftToConfig(
      { ...stdio, id: "Bad__Id", idEdited: true, command: "", env: "oops" },
      none,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual(["command", "env", "id"]);
    expect(draftToConfig({ ...stdio, id: "a__b" }, none).ok).toBe(false);
    const taken = draftToConfig(stdio, new Set(["unity"]));
    expect(!taken.ok && taken.errors.id?.message).toContain("already uses");
    const badEnv = draftToConfig({ ...stdio, env: "A=1\nnope" }, none);
    expect(!badEnv.ok && badEnv.errors.env).toEqual({
      message: "Line {line}: use NAME=value.",
      line: 2,
    });
  });

  it("builds an http config and rejects non-http urls", () => {
    const http = {
      ...stdio,
      kind: "http" as const,
      url: "http://127.0.0.1:8080/mcp",
      headers: "X-Key: abc",
    };
    expect(draftToConfig(http, none)).toMatchObject({
      ok: true,
      config: { transport: { type: "http", url: http.url, headers: { "X-Key": "abc" } } },
    });
    expect(draftToConfig({ ...http, url: "file:///c" }, none).ok).toBe(false);
  });

  it("round-trips through draftFromConfig", () => {
    const result = draftToConfig(stdio, none);
    if (!result.ok) throw new Error("expected ok");
    expect(draftToConfig(draftFromConfig(result.config), none)).toEqual(result);
  });
});

describe("parsePastedLocalMcpConfig", () => {
  it("reads a Claude-style mcpServers block", () => {
    const result = parsePastedLocalMcpConfig(
      JSON.stringify({
        mcpServers: {
          UnityMCP: { command: "uv", args: ["run", "server.py"], env: { A: "1", N: 2 } },
        },
      }),
    );
    expect(result.ok && result.drafts[0]).toMatchObject({
      id: "unitymcp",
      name: "UnityMCP",
      kind: "stdio",
      command: "uv",
      args: "run\nserver.py",
      env: "A=1\nN=2",
    });
  });

  it("accepts VS Code servers, bare entries, JSONC and trailing commas", () => {
    const vscode = parsePastedLocalMcpConfig(
      '{ "servers": { "web": { "type": "http", "url": "http://localhost:3000/mcp" } } }',
    );
    expect(vscode.ok && vscode.drafts[0]).toMatchObject({ kind: "http", name: "web" });

    const bare = parsePastedLocalMcpConfig(`
      "unity": {
        // started by the Unity package
        "command": "C:\\\\uv.exe",
        "args": ["run", "https://example.com/x//y"],
      },`);
    expect(bare.ok && bare.drafts[0]).toMatchObject({
      name: "unity",
      command: "C:\\uv.exe",
      args: "run\nhttps://example.com/x//y",
    });

    const single = parsePastedLocalMcpConfig('{ "command": "npx", "args": ["-y", "pkg"] }');
    expect(single.ok && single.drafts[0]?.command).toBe("npx");
  });

  it("returns every server found", () => {
    const result = parsePastedLocalMcpConfig(
      '{ "mcpServers": { "a": { "command": "x" }, "b": { "url": "http://h/mcp" } } }',
    );
    expect(result.ok && result.drafts.map((draft) => draft.kind)).toEqual(["stdio", "http"]);
  });

  it("explains what it can't use", () => {
    expect(parsePastedLocalMcpConfig("not json")).toEqual({
      ok: false,
      error: "This isn't valid JSON.",
    });
    expect(parsePastedLocalMcpConfig('{ "mcpServers": {} }').ok).toBe(false);
    const sse = parsePastedLocalMcpConfig('{ "x": { "type": "sse", "url": "http://h/sse" } }');
    expect(!sse.ok && sse.error).toContain("SSE");
  });
});

describe("presentation helpers", () => {
  const config: LocalMcpServerConfig = {
    id: "unity",
    name: "Unity",
    enabled: true,
    transport: {
      type: "stdio",
      command: "uv",
      args: ["run", "--directory", "C:\\My Mcp"],
      env: {},
    },
  };

  it("describes transports on one line", () => {
    expect(describeLocalMcpTransport(config)).toBe('uv run --directory "C:\\My Mcp"');
    expect(
      describeLocalMcpTransport({
        ...config,
        transport: { type: "http", url: "http://127.0.0.1:8080/mcp", headers: {} },
      }),
    ).toBe("http://127.0.0.1:8080/mcp");
  });

  it("maps status to labels", () => {
    expect(localMcpStatusPresentation("running", true).label).toBe("Ready");
    expect(localMcpStatusPresentation("failed", true).tone).toBe("error");
    expect(localMcpStatusPresentation("starting", true).pulse).toBe(true);
    expect(localMcpStatusPresentation("running", false).label).toBe("Turned off");
  });
});

const discovered = (
  key: string,
  name: string,
  extra: Partial<LocalMcpDiscoveredServer> = {},
): LocalMcpDiscoveredServer => ({
  key,
  config: {
    id: name.toLowerCase(),
    name,
    enabled: true,
    transport: { type: "http", url: `http://127.0.0.1:8080/${key}`, headers: {} },
  },
  sources: [{ app: "cursor", file: "C:\\Users\\x\\.cursor\\mcp.json", name }],
  ...extra,
});

describe("local MCP discovery presentation", () => {
  const result: LocalMcpDiscoveryResult = {
    servers: [
      discovered("a1", "unityMCP", {
        sources: [
          {
            app: "claude-code",
            file: "C:\\Users\\x\\.claude.json",
            name: "unityMCP",
            project: "E:\\Game\\",
          },
          { app: "codex", file: "C:\\Users\\x\\.codex\\config.toml", name: "unityMCP" },
          { app: "claude-code", file: "C:\\Users\\x\\.claude.json", name: "unityMCP" },
        ],
      }),
      discovered("b2", "github", { addedAs: "github" }),
      discovered("c3", "blender"),
    ],
    skipped: [
      { source: { app: "codex", file: "c", name: "UnityMCP" }, reason: "disabled" },
      { source: { app: "vscode", file: "v", name: "old" }, reason: "sse" },
      { source: { app: "vscode", file: "v2", name: "OLD" }, reason: "sse" },
      { source: { app: "windsurf", file: "w", name: "" }, reason: "invalid" },
    ],
    scannedAt: "2026-11-16T00:00:00.000Z",
  };

  it("lists only servers that are not added yet", () => {
    expect(pendingDiscoveredServers(result, new Set()).map((server) => server.key)).toEqual([
      "a1",
      "c3",
    ]);
    expect(pendingDiscoveredServers(result, new Set(["c3"])).map((server) => server.key)).toEqual([
      "a1",
    ]);
  });

  it("names each source app once, in source order", () => {
    expect(discoverySourceApps(result.servers[0]!.sources)).toEqual(["Claude Code", "Codex"]);
    expect(pathBaseName("E:\\Game\\")).toBe("Game");
    expect(pathBaseName("/home/x/proj")).toBe("proj");
  });

  it("hides skips that were found usable elsewhere and repeats", () => {
    expect(skippedDiscoveryNotes(result)).toEqual([
      { app: "VS Code", name: "old", reason: "sse" },
      { app: "Windsurf", name: "", reason: "invalid" },
    ]);
  });

  it("explains every error kind", () => {
    for (const kind of ["unreachable", "http", "spawn", "closed", "timeout", "protocol"] as const) {
      expect(localMcpErrorExplanation(kind)).toMatch(/\w/);
    }
    expect(localMcpErrorExplanation("unreachable")).toContain("Unity");
  });
});
