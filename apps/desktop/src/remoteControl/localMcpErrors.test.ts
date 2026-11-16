import { describe, expect, it } from "@effect/vitest";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { classifyLocalMcpError } from "./localMcpErrors.ts";

describe("local MCP error classification", () => {
  const http = { transport: "http", connected: true } as const;
  it("expands fetch causes and aggregate errors including native codes and addresses", () => {
    const cause = new TypeError("fetch failed", {
      cause: new AggregateError([
        Object.assign(new Error("connect failed"), {
          code: "ECONNREFUSED",
          address: "127.0.0.1",
          port: 8080,
        }),
        Object.assign(new Error("DNS failed"), { code: "ENOTFOUND" }),
      ]),
    });
    const result = classifyLocalMcpError(cause, http);
    expect(result.kind).toBe("unreachable");
    expect(result.detail).toContain("fetch failed");
    expect(result.detail).toContain("ECONNREFUSED");
    expect(result.detail).toContain("127.0.0.1:8080");
    expect(result.detail).toContain("ENOTFOUND");
  });
  it("recognizes actual SDK HTTP errors and arbitrary HTTP status errors", () => {
    expect(classifyLocalMcpError(new StreamableHTTPError(404, "missing"), http)).toMatchObject({
      kind: "http",
      detail: expect.stringContaining("HTTP 404 Not Found"),
    });
    expect(
      classifyLocalMcpError(Object.assign(new Error("denied"), { statusCode: 403 }), http).kind,
    ).toBe("http");
    expect(
      classifyLocalMcpError(new StreamableHTTPError(-1, "Unexpected content type"), http).kind,
    ).toBe("protocol");
  });
  it("distinguishes stdio startup exit and spawn errors from an established connection closing", () => {
    const closed = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
    expect(classifyLocalMcpError(closed, { transport: "stdio", connected: false }).kind).toBe(
      "spawn",
    );
    expect(classifyLocalMcpError(closed, { transport: "stdio", connected: true }).kind).toBe(
      "closed",
    );
    expect(classifyLocalMcpError(closed, http).kind).toBe("closed");
    expect(classifyLocalMcpError(new Error("SSE stream disconnected: terminated"), http).kind).toBe(
      "closed",
    );
    expect(
      classifyLocalMcpError(Object.assign(new Error("spawn uvx EACCES"), { code: "EACCES" }), {
        transport: "stdio",
        connected: false,
      }),
    ).toEqual({ kind: "spawn", detail: "spawn uvx EACCES" });
  });
  it("recognizes deadlines and SDK/AbortSignal timeouts while preserving protocol errors", () => {
    for (const cause of [
      new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ])
      expect(classifyLocalMcpError(cause, http).kind).toBe("timeout");
    expect(
      classifyLocalMcpError(new McpError(ErrorCode.InvalidParams, "bad parameters"), http).kind,
    ).toBe("protocol");
    const circular = new Error("circular");
    circular.cause = circular;
    expect(classifyLocalMcpError(circular, http)).toEqual({ kind: "protocol", detail: "circular" });
  });
});
