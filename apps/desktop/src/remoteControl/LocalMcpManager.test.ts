// @effect-diagnostics nodeBuiltinImport:off -- Real SDK transports against isolated local test fixtures.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  JSONRPCRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  DesktopMcpProgress,
  LocalMcpServerConfig,
  LocalMcpServerView,
} from "@t3tools/contracts";
import { DESKTOP_MCP_MAX_RESULT_BYTES } from "@t3tools/contracts";
import * as NodeHttp from "node:http";
import * as NodeURL from "node:url";
import { createLocalMcpManager } from "./LocalMcpManager.ts";

const config: LocalMcpServerConfig = {
  id: "unity",
  name: "Unity",
  enabled: true,
  transport: {
    type: "stdio",
    command: process.execPath,
    args: [NodeURL.fileURLToPath(new URL("./fixtures/localMcpServer.mjs", import.meta.url))],
    env: {},
  },
};
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function waitFor(
  manager: ReturnType<typeof createLocalMcpManager>,
  predicate: (view: LocalMcpServerView) => boolean,
) {
  if (manager.views().some(predicate)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const off = manager.onChanged((views) => {
      if (views.some(predicate)) {
        off();
        resolve();
      }
    });
  });
}
async function setup(options: Partial<Parameters<typeof createLocalMcpManager>[0]> = {}) {
  const manager = createLocalMcpManager({ save: async () => {}, ...options });
  const ready = waitFor(manager, (view) => view.status === "running" || view.status === "failed");
  await manager.initialize([config]);
  await ready;
  if (manager.views()[0]?.status !== "running") {
    const error = manager.views()[0]?.error;
    await manager.dispose();
    throw new Error(error);
  }
  return manager;
}
const signal = () => new AbortController().signal;

async function setupHttp() {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    const request = JSONRPCRequestSchema.safeParse(JSON.parse(String(init?.body)));
    if (!request.success) return new Response(null, { status: 202 });
    const { id, method } = request.data;
    let result: unknown;
    if (method === "initialize") {
      result = {
        protocolVersion: "2025-03-26",
        serverInfo: { name: "fixture", version: "1" },
        capabilities: { tools: {} },
      };
    } else if (method === "tools/list") {
      result = {
        tools: ["echo", "large"].map((name) => ({ name, inputSchema: { type: "object" } })),
      };
    } else {
      const { arguments: args } = CallToolRequestSchema.parse(request.data).params;
      const character = typeof args?.character === "string" ? args.character : "x";
      const count = typeof args?.count === "number" ? args.count : 1;
      result = { content: [{ type: "text", text: character.repeat(count) }] };
    }
    return Response.json(
      { jsonrpc: "2.0", id, result },
      { headers: { "mcp-session-id": "fixture" } },
    );
  });
  const manager = createLocalMcpManager({ save: async () => {} });
  const dispose = async () => {
    await manager.dispose();
    fetch.mockRestore();
  };
  try {
    const ready = waitFor(manager, (view) => view.status === "running" || view.status === "failed");
    await manager.initialize([
      { ...config, transport: { type: "http", url: "http://localhost/mcp", headers: {} } },
    ]);
    await ready;
    expect(manager.views()[0]?.status).toBe("running");
    return { manager, dispose };
  } catch (cause) {
    await dispose();
    throw cause;
  }
}

async function listen(http: NodeHttp.Server) {
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.removeListener("error", reject);
      resolve();
    });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  return `http://127.0.0.1:${address.port}/mcp`;
}
async function closeHttp(http: NodeHttp.Server) {
  http.closeAllConnections();
  await new Promise<void>((resolve) => http.close(() => resolve()));
}

it("retains initialize identity on failures, restart failures and disable without publishing it in capabilities", async () => {
  const { manager, dispose } = await setupHttp();
  try {
    await manager.upsert({
      id: "unity-stdio",
      name: "unityMCP",
      enabled: false,
      transport: { type: "stdio", command: "mcp-for-unity", args: [], env: {} },
    });
    const successful = manager.views()[0]!;
    expect(successful).toMatchObject({ serverName: "fixture", serverVersion: "1" });
    expect(manager.views()[1]).toMatchObject({
      group: { key: "product:mcp-for-unity", label: "Unity" },
      duplicateOf: "unity",
    });
    expect(manager.capabilities().servers[0]).toEqual({
      id: "unity",
      name: "Unity",
      status: "running",
      tools: successful.tools,
    });
    const fetch = vi.mocked(globalThis.fetch);
    fetch.mockRejectedValue(new TypeError("fetch failed"));
    const failed = waitFor(manager, (view) => view.status === "failed");
    await expect(manager.call("unity", "echo", {}, signal())).rejects.toMatchObject({
      code: "MCP_SERVER_UNAVAILABLE",
    });
    await failed;
    expect(manager.views()[0]).toMatchObject({
      serverName: "fixture",
      serverVersion: "1",
      toolsUpdatedAt: successful.toolsUpdatedAt,
    });
    expect(manager.views()[1]?.duplicateOf).toBe("unity");
    const restarting = waitFor(manager, (view) => view.status === "starting");
    await manager.restart("unity");
    await restarting;
    await waitFor(manager, (view) => view.status === "failed");
    const disabled = await manager.setEnabled("unity", false);
    expect(disabled[0]).toMatchObject({
      serverName: "fixture",
      serverVersion: "1",
      toolsUpdatedAt: successful.toolsUpdatedAt,
    });
  } finally {
    await dispose();
  }
});

it("records a new initialize identity even when the subsequent tools listing fails", async () => {
  const { manager, dispose } = await setupHttp();
  const info = vi.spyOn(Client.prototype, "getServerVersion").mockReturnValue({
    name: "mcp-for-unity-server",
    version: "3.4.11",
  });
  const list = vi
    .spyOn(Client.prototype, "listTools")
    .mockRejectedValue(new Error("invalid tools response"));
  try {
    const started = waitFor(manager, (view) => view.status === "starting");
    await manager.restart("unity");
    await started;
    await waitFor(manager, (view) => view.status === "failed");
    expect(manager.views()[0]).toMatchObject({
      serverName: "mcp-for-unity-server",
      serverVersion: "3.4.11",
    });
  } finally {
    await dispose();
    info.mockRestore();
    list.mockRestore();
  }
});

it("publishes configured groups with config order preserved when a disabled member is restarted", async () => {
  const manager = createLocalMcpManager({ save: async () => {} });
  const makeConfig = (id: string): LocalMcpServerConfig => ({
    ...config,
    id,
    enabled: false,
    transport: { type: "stdio", command: "mcp-for-unity", args: [], env: {} },
  });
  try {
    await manager.initialize([makeConfig("first"), makeConfig("second")]);
    const snapshots: Array<readonly LocalMcpServerView[]> = [];
    const off = manager.onChanged((views) => snapshots.push(views));
    await manager.restart("first");
    off();
    expect(manager.views().map((view) => view.config.id)).toEqual(["first", "second"]);
    expect(snapshots[0]?.map((view) => view.group)).toEqual([
      { key: "product:mcp-for-unity", label: "Unity" },
      { key: "product:mcp-for-unity", label: "Unity" },
    ]);
    expect(manager.views().every((view) => view.duplicateOf === undefined)).toBe(true);
  } finally {
    await manager.dispose();
  }
});

it.each([undefined, DESKTOP_MCP_MAX_RESULT_BYTES, DESKTOP_MCP_MAX_RESULT_BYTES + 1])(
  "checks HTTP Content-Length %s before reading the response body",
  async (length) => {
    let reads = 0;
    let cancelled = false;
    let calls = 0;
    const oversized = length !== undefined && length > DESKTOP_MCP_MAX_RESULT_BYTES;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "GET") return new Response(null, { status: 405 });
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      const request = JSONRPCRequestSchema.safeParse(JSON.parse(String(init?.body)));
      if (!request.success) return new Response(null, { status: 202 });
      const { id, method } = request.data;
      if (method === "tools/call" && ++calls === 1 && oversized) {
        return new Response(
          new ReadableStream(
            {
              pull: () => {
                reads++;
              },
              cancel: () => {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
          {
            headers: { "content-type": "application/json", "content-length": String(length) },
          },
        );
      }
      const result =
        method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              serverInfo: { name: "fixture", version: "1" },
              capabilities: { tools: {} },
            }
          : method === "tools/list"
            ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: "ok" }] };
      return Response.json(
        { jsonrpc: "2.0", id, result },
        {
          headers: {
            "mcp-session-id": "fixture",
            ...(method === "tools/call" && length !== undefined && !oversized
              ? { "content-length": String(length) }
              : {}),
          },
        },
      );
    });
    const manager = createLocalMcpManager({ save: async () => {} });
    try {
      const ready = waitFor(
        manager,
        (view) => view.status === "running" || view.status === "failed",
      );
      await manager.initialize([
        { ...config, transport: { type: "http", url: "http://localhost/mcp", headers: {} } },
      ]);
      await ready;
      const call = manager.call("unity", "echo", {}, signal());
      if (oversized) {
        await expect(call).rejects.toMatchObject({
          code: "MCP_RESULT_TOO_LARGE",
          message: "MCP_RESULT_TOO_LARGE",
        });
        expect(cancelled).toBe(true);
        expect(reads).toBe(0);
      } else {
        expect(await call).toEqual({ content: [{ type: "text", text: "ok" }] });
      }
      expect(manager.views()[0]?.status).toBe("running");
      expect(await manager.call("unity", "echo", {}, signal())).toEqual({
        content: [{ type: "text", text: "ok" }],
      });
    } finally {
      await manager.dispose();
      fetch.mockRestore();
    }
  },
);

it.each([
  ["stdio", undefined, 60_000],
  ["http", undefined, 20_000],
  ["stdio", 500, 500],
  ["http", 500, 500],
] as const)(
  "bounds %s startup and probe at %s (deadline %s)",
  async (transport, override, timeout) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(signal?.reason);
          if (signal?.aborted) abort();
          else signal?.addEventListener("abort", abort, { once: true });
        }),
    );
    const stalled: LocalMcpServerConfig = {
      ...config,
      transport:
        transport === "http"
          ? { type: "http", url: "http://localhost/mcp", headers: {} }
          : {
              type: "stdio",
              command: process.execPath,
              args: [
                "-e",
                'require("node:fs").createReadStream("", { fd: 0, autoClose: false }).resume()',
              ],
              env: {},
            },
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const manager = createLocalMcpManager({
      save: async () => {},
      ...(override === undefined ? {} : { probeTimeoutMs: override }),
      retryDelaysMs: [300_000],
    });
    try {
      let probed = false;
      const probe = manager.probe(stalled).then((result) => {
        probed = true;
        return result;
      });
      await manager.initialize([stalled]);
      await vi.advanceTimersByTimeAsync(timeout - 1);
      expect(probed).toBe(false);
      expect(manager.views()[0]?.status).toBe("starting");
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.views()[0]).toMatchObject({ status: "failed", errorKind: "timeout" });
      // Let the SDK's child-process cleanup grace periods drain too.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await probe).toMatchObject({ ok: false, errorKind: "timeout" });
    } finally {
      vi.useRealTimers();
      await manager.dispose();
      fetch.mockRestore();
    }
  },
);

it("classifies a refused loopback connection and a live HTTP 404 in probes and views", async () => {
  const http = NodeHttp.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const url = await listen(http);
  const manager = createLocalMcpManager({ save: async () => {}, retryDelaysMs: [60000] });
  const httpConfig: LocalMcpServerConfig = {
    ...config,
    transport: { type: "http", url, headers: {} },
  };
  try {
    expect(await manager.probe(httpConfig)).toMatchObject({
      ok: false,
      errorKind: "http",
      error: expect.stringContaining("HTTP 404 Not Found"),
    });
    const failed = waitFor(manager, (view) => view.status === "failed");
    await manager.initialize([httpConfig]);
    await failed;
    expect(manager.views()[0]).toMatchObject({ errorKind: "http" });
    await closeHttp(http);
    // A fresh port that nothing listens on: reusing the 404 server's port could hit
    // fetch's pooled keep-alive socket and fail with UND_ERR_SOCKET instead.
    const vacant = NodeHttp.createServer();
    const vacantUrl = await listen(vacant);
    await closeHttp(vacant);
    const refusedConfig: LocalMcpServerConfig = {
      ...config,
      transport: { type: "http", url: vacantUrl, headers: {} },
    };
    expect(await manager.probe(refusedConfig)).toMatchObject({
      ok: false,
      errorKind: "unreachable",
      error: expect.stringContaining("ECONNREFUSED"),
    });
    const refused = waitFor(
      manager,
      (view) => view.status === "failed" && view.errorKind === "unreachable",
    );
    await manager.upsert(refusedConfig);
    await refused;
    expect(manager.views()[0]?.error).toContain("ECONNREFUSED");
  } finally {
    await manager.dispose();
    await closeHttp(http);
  }
});

it("reports an HTTP MCP disconnect during a call as unavailable and closed without replaying it", async () => {
  const server = new Server({ name: "disconnect", version: "1" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "hang", inputSchema: { type: "object" } }],
  }));
  const finish = deferred<void>();
  let calls = 0;
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    calls++;
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: request.params._meta!.progressToken!, progress: 1 },
    });
    await finish.promise;
    return { content: [] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "disconnect-session",
  });
  await server.connect(transport as Parameters<Server["connect"]>[0]);
  const http = NodeHttp.createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  const url = await listen(http);
  const manager = createLocalMcpManager({ save: async () => {}, retryDelaysMs: [60000] });
  try {
    const ready = waitFor(manager, (view) => view.status === "running");
    await manager.initialize([{ ...config, transport: { type: "http", url, headers: {} } }]);
    await ready;
    const started = deferred<void>();
    const failed = waitFor(manager, (view) => view.status === "failed");
    const call = manager.call(config.id, "hang", {}, signal(), async () => started.resolve());
    const rejected = expect(call).rejects.toMatchObject({ code: "MCP_SERVER_UNAVAILABLE" });
    await started.promise;
    http.closeAllConnections();
    await rejected;
    await failed;
    expect(manager.views()[0]).toMatchObject({ errorKind: "closed" });
    expect(calls).toBe(1);
  } finally {
    finish.resolve();
    await manager.dispose();
    await server.close();
    await closeHttp(http);
  }
});

describe("LocalMcpManager output limits", () => {
  it.each(["result", "error"])(
    "coalesces SDK bursts and finishes progress before the call %s",
    async (ending) => {
      const { manager, dispose } = await setupHttp();
      const started = deferred<void>();
      const release = deferred<void>();
      const delivered: number[] = [];
      const tool = vi
        .spyOn(Client.prototype, "callTool")
        .mockImplementation(async (_input, _schema, options) => {
          for (let progress = 1; progress <= 1000; progress++) options?.onprogress?.({ progress });
          if (ending === "error") throw new Error("tool failed");
          return { content: [] };
        });
      try {
        let completed = false;
        const work = manager
          .call("unity", "echo", {}, signal(), async (value) => {
            started.resolve();
            await release.promise;
            delivered.push(value.progress);
          })
          .then(
            (result) => {
              completed = true;
              return result;
            },
            (cause: unknown) => {
              completed = true;
              return cause;
            },
          );
        await started.promise;
        expect(completed).toBe(false);
        release.resolve();
        const result = await work;
        expect(delivered).toEqual([1]);
        expect(result).toMatchObject(
          ending === "result" ? { content: [] } : { code: "MCP_PROTOCOL_ERROR" },
        );
      } finally {
        release.resolve();
        tool.mockRestore();
        await dispose();
      }
    },
  );

  it("limits serialized result bytes rather than characters and accepts large results below the limit", async () => {
    const { manager, dispose } = await setupHttp();
    try {
      const count = 3 * 1024 * 1024;
      const result = await manager.call("unity", "large", { character: "x", count }, signal());
      expect(result.content).toEqual([{ type: "text", text: "x".repeat(count) }]);
      await expect(
        manager.call("unity", "large", { character: "汉", count }, signal()),
      ).rejects.toMatchObject({ code: "MCP_RESULT_TOO_LARGE", message: "MCP_RESULT_TOO_LARGE" });
      // JSON escaping also counts toward the serialized size.
      await expect(
        manager.call("unity", "large", { character: "\u0000", count }, signal()),
      ).rejects.toMatchObject({ code: "MCP_RESULT_TOO_LARGE" });
    } finally {
      await dispose();
    }
  });
});

describe("LocalMcpManager SDK stdio", () => {
  it("starts, lists all pages, forwards results including tool errors, progress, and list changes", async () => {
    const manager = await setup();
    try {
      expect(manager.views()[0]?.tools.map((tool) => tool.name)).toEqual([
        "echo",
        "change",
        "hang",
        "large",
        "crash",
      ]);
      const progress: DesktopMcpProgress[] = [];
      const result = await manager.call(
        "unity",
        "echo",
        { value: "你好", isError: true },
        signal(),
        async (value) => {
          progress.push(value);
        },
      );
      expect(result).toEqual({
        content: [{ type: "text", text: "ok" }],
        structuredContent: { value: "你好", isError: true },
        isError: true,
      });
      expect(progress).toEqual([{ progress: 1, total: 2, message: "started" }]);
      const refreshed = waitFor(manager, (view) =>
        view.tools.some((tool) => tool.name === "added"),
      );
      await manager.call("unity", "change", {}, signal());
      await refreshed;
      expect(manager.capabilities().servers[0]?.tools).toHaveLength(6);
      let changes = 0;
      const off = manager.onChanged(() => {
        changes++;
      });
      await manager.call("unity", "change", {}, signal());
      // tools/list follows the notification on the same transport. A probe call is an ordered round trip.
      await manager.call("unity", "echo", {}, signal());
      off();
      expect(changes).toBe(0);
      await expect(manager.call("missing", "echo", {}, signal())).rejects.toMatchObject({
        code: "MCP_SERVER_NOT_FOUND",
      });
      await expect(manager.call("unity", "missing", {}, signal())).rejects.toMatchObject({
        code: "MCP_TOOL_NOT_FOUND",
      });
      await expect(manager.call("unity", "large", {}, signal())).rejects.toMatchObject({
        code: "MCP_RESULT_TOO_LARGE",
      });
    } finally {
      await manager.dispose();
    }
  });

  it("cancels active calls, queues the ninth globally, removes cancelled waiters and releases slots", async () => {
    const manager = await setup();
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const started = Array.from({ length: 10 }, () => deferred<void>());
    const calls = controllers.map((controller, index) =>
      manager
        .call("unity", "hang", {}, controller.signal, async () => {
          started[index]!.resolve();
        })
        .catch((cause: unknown) => cause),
    );
    try {
      await Promise.all(started.slice(0, 8).map((event) => event.promise));
      let ninthStarted = false;
      void started[8]!.promise.then(() => {
        ninthStarted = true;
      });
      controllers[9]!.abort();
      expect(await calls[9]).toMatchObject({ code: "CANCELLED" });
      expect(ninthStarted).toBe(false);
      controllers[0]!.abort();
      expect(await calls[0]).toMatchObject({ code: "CANCELLED" });
      await started[8]!.promise;
      expect(ninthStarted).toBe(true);
    } finally {
      controllers.forEach((controller) => controller.abort());
      await Promise.all(calls);
      expect(await manager.call("unity", "echo", {}, signal())).toMatchObject({ isError: false });
      await manager.dispose();
    }
  });

  it("enforces a total deadline including queued time and progress, and reuses freed slots", async () => {
    const manager = await setup({ callTimeoutMs: 150 });
    try {
      const calls = Array.from({ length: 9 }, () =>
        manager.call("unity", "hang", {}, signal()).catch((cause: unknown) => cause),
      );
      expect(await Promise.all(calls)).toEqual(
        Array.from({ length: 9 }, () => expect.objectContaining({ code: "TIMEOUT" })),
      );
      expect(await manager.call("unity", "echo", {}, signal())).toMatchObject({ isError: false });
    } finally {
      await manager.dispose();
    }
  });

  it("releases a slot when progress delivery is blocked past the total deadline", async () => {
    const manager = await setup({ callTimeoutMs: 150 });
    try {
      await expect(
        manager.call("unity", "echo", {}, signal(), () => new Promise<void>(() => {})),
      ).rejects.toMatchObject({ code: "TIMEOUT" });
      expect(await manager.call("unity", "echo", {}, signal())).toMatchObject({ isError: false });
    } finally {
      await manager.dispose();
    }
  });

  it("bounds an unresponsive probe and returns a failure value", async () => {
    const manager = createLocalMcpManager({ save: async () => {}, probeTimeoutMs: 50 });
    try {
      expect(
        await manager.probe({
          ...config,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [
              "-e",
              'require("node:fs").createReadStream("", { fd: 0, autoClose: false }).resume()',
            ],
            env: {},
          },
        }),
      ).toMatchObject({ ok: false, error: "TIMEOUT", errorKind: "timeout" });
      expect(manager.views()).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("publishes a timeout kind when the startup deadline expires", async () => {
    const manager = createLocalMcpManager({
      save: async () => {},
      probeTimeoutMs: 50,
      retryDelaysMs: [60000],
    });
    try {
      const failed = waitFor(manager, (view) => view.status === "failed");
      await manager.initialize([
        {
          ...config,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: [
              "-e",
              'require("node:fs").createReadStream("", { fd: 0, autoClose: false }).resume()',
            ],
            env: {},
          },
        },
      ]);
      await failed;
      expect(manager.views()[0]).toMatchObject({ errorKind: "timeout", error: "TIMEOUT" });
    } finally {
      await manager.dispose();
    }
  });

  it("keeps the successful catalog on failure and restart failure, and removes disabled servers from capabilities", async () => {
    const manager = await setup({ retryDelaysMs: [60000] });
    try {
      const tools = manager.views()[0]!.tools;
      const failed = waitFor(manager, (view) => view.status === "failed");
      await expect(manager.call("unity", "crash", {}, signal())).rejects.toMatchObject({
        code: "MCP_SERVER_UNAVAILABLE",
      });
      await failed;
      expect(manager.views()[0]).toMatchObject({
        errorKind: "closed",
        error: expect.stringContaining("fixture crashed deliberately"),
      });
      expect(manager.capabilities().servers[0]).toMatchObject({ status: "failed", tools });
      await expect(manager.call("unity", "echo", {}, signal())).rejects.toMatchObject({
        code: "MCP_SERVER_UNAVAILABLE",
      });
      const restartFailed = waitFor(
        manager,
        (view) =>
          view.status === "failed" &&
          view.config.transport.type === "stdio" &&
          view.config.transport.command === "t3-missing-mcp-fixture",
      );
      await manager.upsert({
        ...config,
        transport: { type: "stdio", command: "t3-missing-mcp-fixture", args: [], env: {} },
      });
      await restartFailed;
      expect(manager.views()[0]?.tools).toEqual(tools);
      const recovered = waitFor(manager, (view) => view.status === "running");
      await manager.upsert(config);
      await recovered;
      const restarted = new Promise<void>((resolve) => {
        const off = manager.onChanged((views) => {
          if (views[0]?.status === "running") {
            off();
            resolve();
          }
        });
      });
      await manager.restart("unity");
      await restarted;
      await manager.setEnabled("unity", false);
      expect(manager.capabilities().servers).toEqual([]);
      await expect(manager.call("unity", "echo", {}, signal())).rejects.toMatchObject({
        code: "MCP_SERVER_DISABLED",
      });
    } finally {
      await manager.dispose();
    }
  });

  it("automatically restarts an enabled server after a transport failure", async () => {
    const manager = await setup({ retryDelaysMs: [0] });
    try {
      const failed = waitFor(manager, (view) => view.status === "failed");
      await manager.call("unity", "crash", {}, signal()).catch(() => {});
      await failed;
      await waitFor(manager, (view) => view.status === "running");
      expect(await manager.call("unity", "echo", {}, signal())).toMatchObject({ isError: false });
    } finally {
      await manager.dispose();
    }
  });

  it("probes without persisting and reports failures as values", async () => {
    const manager = createLocalMcpManager({
      save: async () => {
        throw new Error("must not save");
      },
      probeTimeoutMs: 5000,
    });
    try {
      expect(await manager.probe(config)).toMatchObject({
        ok: true,
        serverName: "fixture",
        serverVersion: "1.2.3",
        tools: expect.any(Array),
      });
      expect(
        await manager.probe({
          ...config,
          transport: { type: "stdio", command: "t3-missing-mcp-fixture", args: [], env: {} },
        }),
      ).toMatchObject({ ok: false, errorKind: "spawn", error: expect.stringContaining("ENOENT") });
      expect(
        await manager.probe({
          ...config,
          transport: {
            type: "stdio",
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
            env: {},
          },
        }),
      ).toMatchObject({ ok: false, errorKind: "spawn" });
      expect(manager.views()).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });
});

it("connects to a real loopback Streamable HTTP MCP with configured headers", async () => {
  const server = new Server(
    { name: "http-fixture", version: "1" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "echo", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => ({
    content: [],
    structuredContent: request.params.arguments,
  }));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => "fixture-session",
  });
  await server.connect(transport as Parameters<Server["connect"]>[0]);
  const headers: Array<string | undefined> = [];
  const http = NodeHttp.createServer((request, response) => {
    headers.push(request.headers["authorization"]);
    void transport.handleRequest(request, response);
  });
  const url = await listen(http);
  const manager = createLocalMcpManager({ save: async () => {} });
  try {
    const ready = waitFor(manager, (view) => view.status === "running");
    await manager.initialize([
      {
        ...config,
        transport: {
          type: "http",
          url,
          headers: { Authorization: "Bearer fixture" },
        },
      },
    ]);
    await ready;
    expect(await manager.call("unity", "echo", { value: 42 }, signal())).toEqual({
      content: [],
      structuredContent: { value: 42 },
    });
    expect(headers.every((header) => header === "Bearer fixture")).toBe(true);
  } finally {
    await manager.dispose();
    await server.close();
    await closeHttp(http);
  }
});
