import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ThreadId,
  DESKTOP_EXEC_GRANT_WAIT_MS,
  type LocalMcpAddProposal,
  type LocalMcpDiscoveryResult,
  type LocalMcpServerConfig,
  type LocalMcpServerView,
} from "@t3tools/contracts";
import { createLocalMcpManagement } from "./LocalMcpManagement.ts";
import type { RequestHandler } from "./RemoteControlRequestRouter.ts";

const config: LocalMcpServerConfig = {
  id: "unity",
  name: "Unity",
  enabled: true,
  transport: {
    type: "stdio",
    command: "C:\\secret-dir\\uvx.exe",
    args: ["arg-secret"],
    env: { TOKEN: "env-secret" },
    cwd: "C:\\secret-cwd",
  },
};
const http: LocalMcpServerConfig = {
  id: "web",
  name: "Web",
  enabled: true,
  transport: {
    type: "http",
    url: "https://user:password@example.com:8443/path-secret?query-secret",
    headers: { Authorization: "header-secret" },
  },
};
const discovery: LocalMcpDiscoveryResult = {
  servers: [config, http].map((config, index) => ({
    key: `key${index}`,
    config,
    sources: [{ app: "codex", file: "file-secret", name: config.name }],
  })),
  skipped: [],
  scannedAt: "now",
};
const disposers: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.useRealTimers();
});
function fixture() {
  let views: readonly LocalMcpServerView[] = [];
  let enabledIds = ["env"];
  let found = discovery;
  let status: LocalMcpServerView["status"] = "running";
  const listeners = new Set<() => void>();
  const upsert = vi.fn(async (config: LocalMcpServerConfig) => {
    views = [
      ...views,
      {
        config,
        status,
        ...(status === "failed" ? { errorKind: "spawn" as const, error: "raw-secret" } : {}),
        tools: [],
      },
    ];
    for (const listener of listeners) listener();
    return views;
  });
  const scan = vi.fn(async () => found);
  const service = createLocalMcpManagement({
    manager: {
      views: () => views,
      upsert,
      onChanged: (listener) => {
        const fn = () => listener(views);
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    enabledEnvironmentIds: async () => enabledIds,
    discover: scan,
  });
  disposers.push(() => service.dispose());
  const invoke = (
    kind: "mcp.list" | "mcp.add",
    input: unknown,
    overrides: Partial<Parameters<RequestHandler>[0]> = {},
  ) =>
    service.handlers[kind]({
      request: {
        requestId: "r",
        kind,
        input,
        context: { threadId: ThreadId.make("thread"), provider: "codex", label: "worker" },
        timeoutMs: 170_000,
      },
      environmentId: "env",
      signal: new AbortController().signal,
      emit: async () => {},
      ...overrides,
    });
  const nextProposal = () =>
    new Promise<LocalMcpAddProposal>((resolve) => {
      const off = service.onAddProposalsChanged((proposals) => {
        if (proposals.length) {
          off();
          resolve(proposals.at(-1)!);
        }
      });
    });
  return {
    service,
    invoke,
    nextProposal,
    upsert,
    scan,
    setViews: (next: readonly LocalMcpServerView[]) => {
      views = next;
    },
    setDiscovery: (next: LocalMcpDiscoveryResult) => {
      found = next;
    },
    enable: (ids: string[]) => {
      enabledIds = ids;
    },
    disable: () => {
      enabledIds = [];
    },
    setStatus: (next: typeof status) => {
      status = next;
    },
  };
}

describe("MCP list and add proposals", () => {
  it("lists only safe summary fields and never raw configs, source files or errors", async () => {
    const f = fixture();
    f.setViews([{ config, status: "failed", errorKind: "spawn", error: "raw-secret", tools: [] }]);
    const result = await f.invoke("mcp.list", {});
    expect(result).toMatchObject({
      servers: [{ id: "unity", errorKind: "spawn", toolCount: 0 }],
      candidates: [
        {
          key: "key0",
          apps: ["codex"],
          transport: { type: "stdio", command: "uvx.exe" },
          envNames: ["TOKEN"],
        },
        {
          transport: { type: "http", origin: "https://example.com:8443" },
          headerNames: ["Authorization"],
        },
      ],
    });
    const json = JSON.stringify(result);
    for (const secret of ["secret", "password", "args", "cwd", "file"])
      expect(json).not.toContain(secret);
  });
  it("checks environment authorization for list and add", async () => {
    const f = fixture();
    f.disable();
    for (const kind of ["mcp.list", "mcp.add"] as const)
      await expect(f.invoke(kind, {})).rejects.toMatchObject({ code: "REMOTE_DISABLED" });
    expect(f.scan).not.toHaveBeenCalled();
  });
  it("rescans keys, hides values in proposals and only adds after confirmation", async () => {
    const f = fixture();
    const proposed = f.nextProposal();
    const result = f.invoke("mcp.add", { key: "key0" });
    const proposal = await proposed;
    expect(f.upsert).not.toHaveBeenCalled();
    expect(proposal).toMatchObject({
      origin: "discovered",
      id: "unity",
      environmentId: "env",
      threadId: "thread",
      provider: "codex",
      label: "worker",
      transport: {
        command: config.transport.type === "stdio" && config.transport.command,
        args: ["arg-secret"],
        envNames: ["TOKEN"],
      },
    });
    expect(JSON.stringify(proposal)).not.toContain("env-secret");
    await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "add" });
    expect(await result).toMatchObject({
      id: "unity",
      status: "running",
      toolPrefix: "mcp__t3-win__unity__",
    });
    expect(f.upsert).toHaveBeenCalledWith(config);
    expect(f.service.listAddProposals()).toEqual([]);
  });
  it("returns existing servers without a proposal and reports missing keys", async () => {
    const f = fixture();
    f.setViews([{ config, status: "running", tools: [] }]);
    f.setDiscovery({ ...discovery, servers: [{ ...discovery.servers[0]!, addedAs: "unity" }] });
    expect(await f.invoke("mcp.add", { key: "key0" })).toMatchObject({ id: "unity" });
    expect(f.service.listAddProposals()).toEqual([]);
    await expect(f.invoke("mcp.add", { key: "missing" })).rejects.toMatchObject({
      code: "MCP_SERVER_NOT_FOUND",
      message: expect.stringContaining("win mcp list"),
    });
  });
  it("validates configs, defaults credentials, deduplicates ids and returns failed startup as a result", async () => {
    const f = fixture();
    await expect(f.invoke("mcp.add", { config: { name: "Invalid" } })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    f.setViews([{ config, status: "running", tools: [] }]);
    f.setStatus("failed");
    const proposed = f.nextProposal();
    const result = f.invoke("mcp.add", {
      config: {
        id: "unity",
        name: "Unity",
        transport: {
          type: "http",
          url: "https://example.com/mcp",
          headers: { Token: "header-secret" },
        },
      },
    });
    const proposal = await proposed;
    expect(proposal).toMatchObject({
      id: "unity-2",
      origin: "agent",
      // The agent already knows what it wrote, so the user sees the value too.
      transport: {
        url: "https://example.com/mcp",
        headerNames: ["Token"],
        headers: { Token: "header-secret" },
      },
    });
    await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "add" });
    expect(await result).toMatchObject({ id: "unity-2", status: "failed", errorKind: "spawn" });
    expect(JSON.stringify(await result)).not.toContain("raw-secret");
  });
  it("denies without saving and rejects invented, consumed or expired ids", async () => {
    const f = fixture();
    await expect(
      f.service.resolveAddProposal({ proposalId: "forged", decision: "add" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const proposed = f.nextProposal();
    const result = f.invoke("mcp.add", { key: "key0" });
    const rejected = expect(result).rejects.toMatchObject({ code: "GRANT_DENIED" });
    const proposal = await proposed;
    await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "deny" });
    await rejected;
    await expect(
      f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "add" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it("expires confirmation after the grant deadline", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const proposed = f.nextProposal();
    const result = f.invoke("mcp.add", { key: "key0" });
    const rejected = expect(result).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "The user did not confirm on the PC in time",
    });
    const proposal = await proposed;
    await vi.advanceTimersByTimeAsync(DESKTOP_EXEC_GRANT_WAIT_MS);
    await rejected;
    expect(f.service.listAddProposals()).toEqual([]);
    await expect(
      f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "add" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("withdraws on cancellation and never proposes an already aborted request", async () => {
    const f = fixture();
    const controller = new AbortController();
    const proposed = f.nextProposal();
    const result = f.invoke("mcp.add", { key: "key0" }, { signal: controller.signal });
    const rejected = expect(result).rejects.toMatchObject({ code: "CANCELLED" });
    await proposed;
    controller.abort();
    await rejected;
    expect(f.service.listAddProposals()).toEqual([]);
    await expect(
      f.invoke("mcp.add", { key: "key0" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(f.upsert).not.toHaveBeenCalled();
  });
  it.each(["key", "config"])(
    "merges identical %s proposals and cancels each waiter independently",
    async (type) => {
      const f = fixture();
      const first = new AbortController();
      const input =
        type === "key"
          ? { key: "key0" }
          : {
              config: {
                name: "Unity",
                transport: { type: "stdio", command: "uvx", args: [], env: { A: "1", B: "2" } },
              },
            };
      const proposed = f.nextProposal();
      const a = f.invoke("mcp.add", input, { signal: first.signal });
      const rejected = expect(a).rejects.toMatchObject({ code: "CANCELLED" });
      const proposal = await proposed;
      const joined = f.nextProposal();
      const b = f.invoke(
        "mcp.add",
        type === "key"
          ? input
          : {
              config: {
                name: "Unity",
                transport: { type: "stdio", command: "UVX", args: [], env: { B: "2", A: "1" } },
              },
            },
      );
      await joined;
      expect(f.service.listAddProposals()).toHaveLength(1);
      first.abort();
      await rejected;
      expect(f.service.listAddProposals()).toHaveLength(1);
      await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "add" });
      expect(await b).toMatchObject({ id: "unity" });
      expect(f.upsert).toHaveBeenCalledTimes(1);
    },
  );
  it("limits pending proposals globally", async () => {
    const f = fixture();
    const controllers: AbortController[] = [];
    const results: Promise<unknown>[] = [];
    for (let index = 0; index < 5; index++) {
      const controller = new AbortController();
      controllers.push(controller);
      const proposed = f.nextProposal();
      results.push(
        f
          .invoke(
            "mcp.add",
            {
              config: {
                name: `Server ${index}`,
                transport: { type: "stdio", command: "uvx", args: [] },
              },
            },
            { signal: controller.signal },
          )
          .catch((error: unknown) => error),
      );
      await proposed;
    }
    await expect(f.invoke("mcp.add", { key: "key0" })).rejects.toMatchObject({ code: "HOST_BUSY" });
    for (const controller of controllers) controller.abort();
    await Promise.all(results);
    expect(f.service.listAddProposals()).toEqual([]);
  });
  it("keeps identical proposals separate across threads and environments", async () => {
    const f = fixture();
    f.enable(["env", "other"]);
    const results: Promise<unknown>[] = [];
    for (const [environmentId, threadId] of [
      ["env", "one"],
      ["env", "two"],
      ["other", "one"],
    ] as const) {
      const proposed = f.nextProposal();
      results.push(
        f
          .invoke(
            "mcp.add",
            { key: "key0" },
            {
              environmentId,
              request: {
                requestId: "r",
                kind: "mcp.add",
                input: { key: "key0" },
                context: { threadId: ThreadId.make(threadId) },
                timeoutMs: 170_000,
              },
            },
          )
          .catch((error: unknown) => error),
      );
      await proposed;
    }
    expect(f.service.listAddProposals()).toHaveLength(3);
    expect(new Set(f.service.listAddProposals().map((p) => p.id)).size).toBe(3);
    for (const proposal of f.service.listAddProposals())
      await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "deny" });
    expect(await Promise.all(results)).toEqual([
      expect.objectContaining({ code: "GRANT_DENIED" }),
      expect.objectContaining({ code: "GRANT_DENIED" }),
      expect.objectContaining({ code: "GRANT_DENIED" }),
    ]);
  });
  it("shows the values an agent wrote but never those found in other apps", async () => {
    const f = fixture();
    const proposed = f.nextProposal();
    const result = f.invoke("mcp.add", {
      config: {
        name: "Blender",
        transport: { type: "stdio", command: "uvx", args: [], env: { NODE_OPTIONS: "--x" } },
      },
    });
    const proposal = await proposed;
    expect(proposal.transport).toMatchObject({
      envNames: ["NODE_OPTIONS"],
      env: { NODE_OPTIONS: "--x" },
    });
    await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "deny" });
    await expect(result).rejects.toMatchObject({ code: "GRANT_DENIED" });
    const discovered = f.nextProposal();
    const pendingDiscovered = f.invoke("mcp.add", { key: "key0" });
    const fromApps = await discovered;
    expect(fromApps.transport).not.toHaveProperty("env");
    expect(fromApps.transport).not.toHaveProperty("headers");
    await f.service.resolveAddProposal({ proposalId: fromApps.proposalId, decision: "deny" });
    await expect(pendingDiscovered).rejects.toMatchObject({ code: "GRANT_DENIED" });
  });
  it("adds stdio configs with default credentials and rechecks authorization on confirmation", async () => {
    const f = fixture();
    const input = {
      config: { name: "Unity MCP", transport: { type: "stdio", command: "uvx", args: [] } },
    };
    const proposed = f.nextProposal();
    const result = f.invoke("mcp.add", input);
    const proposal = await proposed;
    expect(proposal).toMatchObject({ id: "unity", transport: { envNames: [] } });
    await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "add" });
    expect(await result).toHaveProperty("status", "running");
    expect(f.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        transport: { type: "stdio", command: "uvx", args: [], env: {} },
      }),
    );
    const next = f.nextProposal();
    const denied = f.invoke("mcp.add", input);
    const rejected = expect(denied).rejects.toMatchObject({ code: "REMOTE_DISABLED" });
    const second = await next;
    f.disable();
    await f.service.resolveAddProposal({ proposalId: second.proposalId, decision: "add" });
    await rejected;
    expect(f.upsert).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["key0", 65_000],
    ["key1", 20_000],
  ] as const)(
    "bounds startup waiting for %s and does not replace an id taken during confirmation",
    async (key, deadline) => {
      vi.useFakeTimers();
      const f = fixture();
      f.setStatus("starting");
      const proposed = f.nextProposal();
      const result = f.invoke("mcp.add", { key });
      const proposal = await proposed;
      await f.service.resolveAddProposal({ proposalId: proposal.proposalId, decision: "add" });
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ status: "starting" });
      const next = f.nextProposal();
      const collision = f.invoke("mcp.add", { key: "key1" });
      const rejected = expect(collision).rejects.toMatchObject({ code: "HOST_BUSY" });
      const second = await next;
      f.setViews([{ config: { ...http, id: second.id }, status: "running", tools: [] }]);
      await f.service.resolveAddProposal({ proposalId: second.proposalId, decision: "add" });
      await rejected;
      expect(f.upsert).toHaveBeenCalledTimes(1);
    },
  );
});
