import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DesktopMcpAddInput,
  DesktopMcpAddResult,
  DesktopMcpListResult,
  LocalMcpAddDecision,
  LocalMcpAddProposal,
  LocalMcpDiscoveredServer,
  LocalMcpServerView,
  LocalMcpServiceGroup,
} from "./desktopMcp.ts";

const decode = Schema.decodeUnknownSync(DesktopMcpAddInput, { onExcessProperty: "error" });
const decodeList = Schema.decodeUnknownSync(DesktopMcpListResult);
const decodeResult = Schema.decodeUnknownSync(DesktopMcpAddResult);
const decodeProposal = Schema.decodeUnknownSync(LocalMcpAddProposal);
const decodeDecision = Schema.decodeUnknownSync(LocalMcpAddDecision);
const decodeGroup = Schema.decodeSync(LocalMcpServiceGroup);
const config = { name: "Unity", transport: { type: "stdio", command: "uvx", args: ["unity"] } };
describe("desktop MCP management contracts", () => {
  it("decodes old views and discovery data, and accepts optional local grouping metadata", () => {
    const decodeView = Schema.decodeUnknownSync(LocalMcpServerView);
    const decodeServer = Schema.decodeUnknownSync(LocalMcpDiscoveredServer);
    const localConfig = {
      id: "unity",
      name: "Unity",
      enabled: true,
      transport: { type: "http", url: "http://127.0.0.1:8080/mcp", headers: {} },
    };
    const oldView = { config: localConfig, status: "stopped", tools: [] };
    const oldServer = { key: "transport-key", config: localConfig, sources: [] };
    expect(decodeView(oldView)).toEqual(oldView);
    expect(decodeServer(oldServer)).toEqual(oldServer);
    const group = { key: "product:mcp-for-unity", label: "Unity" };
    const groupedView = {
      ...oldView,
      group,
      duplicateOf: "unity-http",
      serverName: "mcp-for-unity-server",
      serverVersion: "3.4.11",
    };
    const groupedServer = { ...oldServer, group, preferred: false, duplicateOf: "unity-http" };
    expect(decodeView(groupedView)).toEqual(groupedView);
    expect(decodeServer(groupedServer)).toEqual(groupedServer);
    expect(() => decodeGroup({ key: "", label: "Unity" })).toThrow();
    expect(() => decodeView({ ...groupedView, duplicateOf: "bad__id" })).toThrow();
  });
  it("accepts either discovered keys or configs with optional id and credentials", () => {
    expect(decode({ key: "key" })).toEqual({ key: "key" });
    expect(decode({ config })).toEqual({ config });
    expect(
      decode({
        config: {
          id: "unity",
          name: "Unity",
          transport: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "secret" },
          },
        },
      }),
    ).toHaveProperty("config.id", "unity");
  });
  it.each([
    {},
    { key: "" },
    { key: "key", config },
    { config: { ...config, id: "bad__id" } },
    { config: { ...config, transport: { type: "stdio", command: "", args: [] } } },
    { config: { ...config, transport: { type: "http", url: "file:///secret" } } },
    { config: { ...config, transport: { type: "http", url: "invalid" } } },
    { config: { ...config, enabled: true } },
  ])("rejects malformed or mixed input %#", (input) => expect(() => decode(input)).toThrow());
  it("validates summaries and renderer decisions without credential fields", () => {
    expect(decodeList({ servers: [], candidates: [], skipped: 0 })).toEqual({
      servers: [],
      candidates: [],
      skipped: 0,
    });
    expect(
      decodeResult({
        id: "unity",
        name: "Unity",
        status: "failed",
        errorKind: "spawn",
        toolCount: 0,
        toolPrefix: "mcp__t3-win__unity__",
      }).status,
    ).toBe("failed");
    const proposal = {
      proposalId: "p",
      environmentId: "e",
      threadId: null,
      provider: null,
      label: null,
      origin: "agent",
      id: "unity",
      name: "Unity",
      transport: { type: "stdio", command: "uvx", args: [], envNames: ["TOKEN"] },
      requestedAt: "now",
      expiresAt: "later",
    };
    expect(decodeProposal(proposal)).toEqual(proposal);
    expect(decodeDecision({ proposalId: "p", decision: "add" }).decision).toBe("add");
    expect(() => decodeDecision({ proposalId: "p", decision: "upsert" })).toThrow();
  });
});
