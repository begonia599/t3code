import { expect, it, vi } from "vite-plus/test";
import { createLocalMcpRequestHandler } from "./LocalMcpRequestHandler.ts";
import { LocalMcpError } from "./LocalMcpManager.ts";
import type { RequestHandler } from "./RemoteControlRequestRouter.ts";

const input = (): Parameters<RequestHandler>[0] => ({
  request: {
    requestId: "r",
    kind: "mcp.call",
    input: { serverId: "unity", toolName: "inspect", arguments: { secret: true } },
    context: { threadId: "t", provider: "codex", label: "label" },
    timeoutMs: 1000,
  },
  environmentId: "env",
  signal: new AbortController().signal,
  emit: async () => {},
});

it.each([false, true, undefined])(
  "audits isError=%s without changing the result",
  async (isError) => {
    const result = { content: [], ...(isError === undefined ? {} : { isError }) };
    const appendAudit = vi.fn(async () => {});
    const handler = createLocalMcpRequestHandler({
      manager: { call: async () => result },
      store: { appendAudit },
      enabledEnvironmentIds: async () => ["env"],
    });
    expect(await handler(input())).toBe(result);
    expect(appendAudit).toHaveBeenCalledOnce();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "exited",
        errorCode: isError ? "MCP_TOOL_ERROR" : null,
        summary: "unity__inspect",
        threadId: "t",
        provider: "codex",
        label: "label",
        exitCode: null,
        winCwd: null,
      }),
    );
    expect(JSON.stringify(appendAudit.mock.calls)).not.toContain("secret");
  },
);

it.each(["HOST_DISCONNECTED", "HOST_REPLACED", "CLEANUP_FAILED"])(
  "audits %s as unknown",
  async (code) => {
    const appendAudit = vi.fn(async () => {});
    const handler = createLocalMcpRequestHandler({
      manager: {
        call: async () => {
          throw new LocalMcpError(code);
        },
      },
      store: { appendAudit },
      enabledEnvironmentIds: async () => ["env"],
    });
    const controller = new AbortController();
    controller.abort();
    await expect(handler({ ...input(), signal: controller.signal })).rejects.toMatchObject({
      code,
    });
    expect(appendAudit).toHaveBeenCalledOnce();
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", errorCode: code }),
    );
  },
);

it("warns on audit failure while preserving tool results and errors", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const store = {
      appendAudit: async () => {
        throw new Error("disk full");
      },
    };
    const enabledEnvironmentIds = async () => ["env"];
    const result = { content: [] };
    expect(
      await createLocalMcpRequestHandler({
        manager: { call: async () => result },
        store,
        enabledEnvironmentIds,
      })(input()),
    ).toBe(result);
    await expect(
      createLocalMcpRequestHandler({
        manager: {
          call: async () => {
            throw new LocalMcpError("MCP_PROTOCOL_ERROR");
          },
        },
        store,
        enabledEnvironmentIds,
      })(input()),
    ).rejects.toMatchObject({ code: "MCP_PROTOCOL_ERROR" });
    expect(warning).toHaveBeenCalledTimes(2);
  } finally {
    warning.mockRestore();
  }
});

it.each([
  ["HOST_DISABLED", "error"],
  ["TIMEOUT", "timedOut"],
] as const)("audits %s as %s", async (code, outcome) => {
  const appendAudit = vi.fn(async () => {});
  const handler = createLocalMcpRequestHandler({
    manager: {
      call: async () => {
        throw new LocalMcpError(code);
      },
    },
    store: { appendAudit },
    enabledEnvironmentIds: async () => ["env"],
  });
  await expect(handler(input())).rejects.toMatchObject({ code });
  expect(appendAudit).toHaveBeenCalledOnce();
  expect(appendAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome, errorCode: code }));
});
