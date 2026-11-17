// @effect-diagnostics nodeBuiltinImport:off -- Real SDK transports against isolated local test fixtures.
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type {
  DesktopMcpProgress,
  LocalMcpServerConfig,
  LocalMcpServerView,
} from "@t3tools/contracts";
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
