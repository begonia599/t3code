import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DesktopMcpAddInput,
  DesktopMcpAddResult,
  DesktopMcpListResult,
  LocalMcpAddDecision,
  LocalMcpAddProposal,
} from "./desktopMcp.ts";

const decode = Schema.decodeUnknownSync(DesktopMcpAddInput, { onExcessProperty: "error" });
const decodeList = Schema.decodeUnknownSync(DesktopMcpListResult);
const decodeResult = Schema.decodeUnknownSync(DesktopMcpAddResult);
const decodeProposal = Schema.decodeUnknownSync(LocalMcpAddProposal);
const decodeDecision = Schema.decodeUnknownSync(LocalMcpAddDecision);
const config = { name: "Unity", transport: { type: "stdio", command: "uvx", args: ["unity"] } };
describe("desktop MCP management contracts", () => {
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
