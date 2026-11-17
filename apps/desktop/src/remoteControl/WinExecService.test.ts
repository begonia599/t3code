// @effect-diagnostics nodeBuiltinImport:off -- Real isolated child processes and files exercise the native execution adapter.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeChildProcess from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  DesktopExecResult,
  DesktopExecProgress,
  DesktopExecLogResult,
  DesktopStatusResult,
  ThreadId,
  EnvironmentId,
  ProjectId,
  DESKTOP_EXEC_OUTPUT_LIMIT_BYTES,
  DESKTOP_EXEC_CHUNK_BYTES,
} from "@t3tools/contracts";
import { buildExecEnvironment, createWinExecService, runProcess } from "./WinExecService.ts";
import { createRemoteControlStore } from "./RemoteControlStore.ts";
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from "../settings/DesktopAppSettings.ts";
import type { RequestHandler } from "./RemoteControlRequestRouter.ts";

const decodeResult = Schema.decodeUnknownSync(DesktopExecResult);
const decodeProgress = Schema.decodeSync(Schema.fromJsonString(DesktopExecProgress));
const decodeStatus = Schema.decodeUnknownSync(DesktopStatusResult);
const decodeLog = Schema.decodeUnknownSync(DesktopExecLogResult);

const spawnOverride = vi.hoisted(() => ({
  run: undefined as
    | ((...args: Parameters<typeof NodeChildProcess.spawn>) => NodeChildProcess.ChildProcess)
    | undefined,
}));
const children = vi.hoisted(() => [] as NodeChildProcess.ChildProcess[]);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      if (spawnOverride.run) return spawnOverride.run(...args);
      const child = original.spawn(...args);
      children.push(child);
      return child;
    },
  };
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
type Event = Parameters<Parameters<RequestHandler>[0]["emit"]>[0];
let dir: string;
let store: Awaited<ReturnType<typeof createRemoteControlStore>>;
let service: ReturnType<typeof createWinExecService>;
let config: DesktopSettings["remoteControl"];
let counter = 0;
let syncEnvironment:
  | ((environmentId: string) => Promise<Readonly<Record<string, string>>>)
  | undefined;
// Restricted Linux sandboxes can make uv_guess_handle classify pipe sockets as
// UNKNOWN, so Node replaces process.stdout with a no-op Writable. File-descriptor
// streams exercise real pipe backpressure without relying on that classification.
const pipeOutput = `for (const [name, fd] of [["stdout", 1], ["stderr", 2]]) Object.defineProperty(process, name, { value: require("node:fs").createWriteStream("", { fd, autoClose: false }) });`;
const request = (script: string, extra = {}) => ({
  requestId: `r${++counter}`,
  kind: "exec",
  input: {
    mode: "argv",
    argv: [process.execPath, "-e", pipeOutput + script],
    serverCwd: "/work",
    timeoutMs: 10_000,
    env: {},
    noSync: false,
    ...extra,
  },
  timeoutMs: 120_000,
  context: { threadId: ThreadId.make("thread"), provider: "codex" },
});
const execute = (
  script: string,
  emit: (event: Event) => Promise<void> = async () => {},
  extra = {},
  signal = new AbortController().signal,
) =>
  service.handlers.exec!({ request: request(script, extra), environmentId: "env", signal, emit });
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-exec-test-"));
  config = {
    ...DEFAULT_DESKTOP_SETTINGS.remoteControl,
    enabledEnvironmentIds: ["env"],
    mappings: [{ serverPath: "/work", winPath: "C:\\work" }],
  };
  store = await createRemoteControlStore({ stateDir: dir });
  const grant = store.authorize(
    {
      environmentId: "env",
      threadId: "thread",
      provider: "codex",
      label: null,
      mode: "argv",
      summary: "fixture",
      winCwd: "C:\\work",
      strictMode: false,
    },
    new AbortController().signal,
    async () => {},
  );
  await store.resolveGrant({
    grantRequestId: store.getPendingGrantRequests()[0]!.grantRequestId,
    decision: "allow-session",
  });
  await grant;
  service = createWinExecService({
    platform: "linux" as const,
    store,
    getConfig: async () => config,
    localDirectory: () => dir,
    syncEnvironment: (id) => syncEnvironment?.(id) ?? Promise.resolve({}),
  });
  children.length = 0;
  syncEnvironment = undefined;
});
afterEach(async () => {
  await service.disconnectAll();
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

describe("bundled search tools environment", () => {
  it.each(["Path", "PATH", "path"])(
    "prepends tools and keeps a single %s variable",
    async (key) => {
      const tools = NodePath.join(dir, "win-tools");
      await NodeFSP.mkdir(tools);
      const parentEnv = { ...process.env };
      const env = await buildExecEnvironment(
        { PATH: "C:\\parent", [key]: "D:\\custom;C:\\Windows" },
        "win32",
        dir,
      );
      expect(Object.keys(env).filter((name) => name.toLowerCase() === "path")).toEqual([key]);
      expect(env[key]).toBe(`${tools};D:\\custom;C:\\Windows`);
      expect(process.env).toEqual(parentEnv);
    },
  );

  it("uses inherited PATH casing and handles absent or empty PATH", async () => {
    await NodeFSP.mkdir(NodePath.join(dir, "win-tools"));
    try {
      for (const key of Object.keys(process.env))
        if (key.toLowerCase() === "path") vi.stubEnv(key, undefined);
      vi.stubEnv("Path", "C:\\Windows");
      const inherited = await buildExecEnvironment({}, "win32", dir);
      expect(Object.keys(inherited).filter((name) => name.toLowerCase() === "path")).toEqual([
        "Path",
      ]);
      expect(inherited.Path).toBe(`${NodePath.join(dir, "win-tools")};C:\\Windows`);
      vi.stubEnv("Path", undefined);
      for (const overlay of [{}, { Path: "" }]) {
        const env = await buildExecEnvironment(overlay, "win32", dir);
        const keys = Object.keys(env).filter((name) => name.toLowerCase() === "path");
        expect(keys).toHaveLength(1);
        expect(env[keys[0]!]).toBe(NodePath.join(dir, "win-tools"));
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("skips missing resources, non-directories and non-Windows platforms", async () => {
    const overlay = { Path: "C:\\Windows" };
    expect((await buildExecEnvironment(overlay, "win32", undefined)).Path).toBe(overlay.Path);
    expect((await buildExecEnvironment(overlay, "win32", dir)).Path).toBe(overlay.Path);
    await NodeFSP.writeFile(NodePath.join(dir, "win-tools"), "not a directory");
    expect((await buildExecEnvironment(overlay, "win32", dir)).Path).toBe(overlay.Path);
    await NodeFSP.rm(NodePath.join(dir, "win-tools"));
    await NodeFSP.mkdir(NodePath.join(dir, "win-tools"));
    for (const platform of ["linux", "darwin"] as const)
      expect((await buildExecEnvironment(overlay, platform, dir)).Path).toBe(overlay.Path);
  });
});

describe("execution", () => {
  it("streams each pipe, emits valid progress, preserves exit codes and writes audit", async () => {
    const events: Event[] = [];
    const result = decodeResult(
      await execute(
        'process.stdout.write("你好"); process.stderr.write("warning"); process.exitCode = 7',
        async (event) => {
          events.push(event);
        },
      ),
    );
    expect(
      events
        .filter((e) => e.kind === "stdout")
        .map((e) => e.data)
        .join(""),
    ).toBe("你好");
    expect(
      events
        .filter((e) => e.kind === "stderr")
        .map((e) => e.data)
        .join(""),
    ).toBe("warning");
    const progress = events.filter((e) => e.kind === "progress").map((e) => decodeProgress(e.data));
    expect(progress).toMatchObject([
      { type: "started", winCwd: "C:\\work", executable: process.execPath },
    ]);
    expect(result).toMatchObject({
      exitCode: 7,
      outcome: "exited",
      stdoutBytes: 6,
      stderrBytes: 7,
      decodedAsGbk: false,
      truncated: false,
    });
    const rows = (await NodeFSP.readFile(NodePath.join(dir, "remote-control-audit.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows.map((row) => row.outcome)).toEqual(["running", "exited"]);
    expect((await store.readAudit({ limit: 1 }))[0]).toMatchObject({
      exitCode: 7,
      provider: "codex",
    });
  });
  it("pauses both pipes until a blocked emit resolves", async () => {
    const blocked = deferred<void>();
    const release = deferred<void>();
    let held = false;
    const result = execute(
      'process.stdout.write("x".repeat(1024 * 1024)); process.stderr.write("end")',
      async (event) => {
        if (event.kind === "stdout" && !held) {
          held = true;
          blocked.resolve();
          await release.promise;
        }
      },
    );
    await blocked.promise;
    expect(children[0]?.stdout?.isPaused()).toBe(true);
    expect(children[0]?.stderr?.isPaused()).toBe(true);
    release.resolve();
    expect(await result).toMatchObject({
      outcome: "exited",
      stdoutBytes: 1024 * 1024,
      stderrBytes: 3,
    });
  });
  it("truncates once and keeps draining enough output for the child to finish", async () => {
    let forwarded = 0;
    let truncated = 0;
    const result = await execute(
      `process.stdout.write("汉".repeat(${Math.ceil(DESKTOP_EXEC_OUTPUT_LIMIT_BYTES / 3) + 500_000}));`,
      async (event) => {
        if (event.kind === "stdout") {
          const bytes = Buffer.byteLength(event.data);
          expect(bytes).toBeLessThanOrEqual(DESKTOP_EXEC_CHUNK_BYTES);
          expect(event.data).not.toContain("�");
          forwarded += bytes;
        }
        if (event.kind === "progress" && JSON.parse(event.data).type === "truncated") truncated++;
      },
    );
    expect(result).toMatchObject({
      outcome: "exited",
      exitCode: 0,
      truncated: true,
      stdoutBytes: forwarded,
    });
    expect(forwarded).toBeLessThanOrEqual(DESKTOP_EXEC_OUTPUT_LIMIT_BYTES);
    expect(forwarded).toBeGreaterThan(DESKTOP_EXEC_OUTPUT_LIMIT_BYTES - 3);
    expect(truncated).toBe(1);
  });
  it("decodes GBK separately per stream and overlays the environment", async () => {
    const events: Event[] = [];
    const result = await execute(
      'process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4])); process.stderr.write(process.env.TEST_KEY + ":" + process.env.PYTHONIOENCODING)',
      async (e) => {
        events.push(e);
      },
      { env: { TEST_KEY: "ok" } },
    );
    expect(result).toMatchObject({ decodedAsGbk: true });
    expect(events.find((e) => e.kind === "stdout")?.data).toBe("中文");
    expect(events.find((e) => e.kind === "stderr")?.data).toBe("ok:utf-8");
  });
  it("audits invalid input, cwd errors, missing programs, disabled environments and denials", async () => {
    for (const [extra, code] of [
      [{ mode: "invalid" }, "BAD_REQUEST"],
      [{ serverCwd: "/missing" }, "CWD_NOT_MAPPED"],
      [{ winCwd: "D:\\outside" }, "CWD_NOT_ALLOWED"],
      [{ argv: ["t3-nonexistent-command-123"] }, "SPAWN_NOT_FOUND"],
    ] as const) {
      await expect(execute("", undefined, extra)).rejects.toMatchObject({ code });
    }
    config = { ...config, enabledEnvironmentIds: [] };
    await expect(execute("")).rejects.toMatchObject({ code: "REMOTE_DISABLED" });
    config = { ...config, enabledEnvironmentIds: ["env"], strictMode: true };
    const pending = deferred<void>();
    const denied = execute("", async (event) => {
      if (event.kind === "progress") pending.resolve();
    });
    const rejection = expect(denied).rejects.toMatchObject({ code: "GRANT_DENIED" });
    await pending.promise;
    await store.resolveGrant({
      grantRequestId: store.getPendingGrantRequests()[0]!.grantRequestId,
      decision: "deny",
    });
    await rejection;
    const entries = await store.readAudit({ limit: 20 });
    expect(entries).toHaveLength(6);
    expect(entries.every((e) => e.outcome === "error" && e.finishedAt !== null)).toBe(true);
  });
  it("maps raw spawn errors to protocol errors", async () => {
    const opts = {
      platform: "linux" as const,
      executable: NodePath.join(dir, "missing"),
      args: [],
      cwd: dir,
      winCwd: "C:\\work",
      env: process.env,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      emit: async () => {},
    };
    await expect(runProcess(opts)).rejects.toMatchObject({ code: "SPAWN_NOT_FOUND" });
    const file = NodePath.join(dir, "not-executable");
    await NodeFSP.writeFile(file, "hi", { mode: 0o600 });
    await expect(runProcess({ ...opts, executable: file })).rejects.toMatchObject({
      code: "SPAWN_FAILED",
    });
  });
});

it.each(["timeout", "cancel"])(
  "kills child and grandchild on %s and waits for pipe closure",
  async (mode) => {
    // Let the real grandchild report readiness before advancing the host deadline.
    // Parallel SDK imports must not turn this process-tree test into a startup-speed test.
    if (mode === "timeout") vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const ready = deferred<number>();
      const controller = new AbortController();
      let parentPid = 0;
      const script = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(pipeOutput)} + 'process.stdout.write(String(process.pid)); setInterval(()=>{},1000)'], {stdio:['ignore','pipe','inherit']}); child.stdout.on('data', b=>process.stdout.write(b)); setInterval(()=>{},1000)`;
      const result = execute(
        script,
        async (event) => {
          if (event.kind === "progress" && JSON.parse(event.data).type === "started")
            parentPid = JSON.parse(event.data).pid;
          if (event.kind === "stdout") ready.resolve(Number(event.data));
        },
        { timeoutMs: mode === "timeout" ? 500 : 10_000 },
        controller.signal,
      );
      const grandchildPid = await ready.promise;
      if (mode === "cancel") controller.abort();
      else await vi.advanceTimersByTimeAsync(500);
      expect(await result).toMatchObject({
        outcome: mode === "timeout" ? "timedOut" : "cancelled",
      });
      for (const pid of [parentPid, grandchildPid]) {
        expect(pid).toBeGreaterThan(0);
        // Reparented grandchildren can remain zombies until init reaps them.
        const state = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "gone");
        expect(state === "gone" || /^\d+ \(.*\) Z /.test(state)).toBe(true);
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

it.each(["timeout", "cancel"])("unblocks a stalled emit during %s", async (mode) => {
  const blocked = deferred<void>();
  const controller = new AbortController();
  const result = execute(
    'process.stdout.write("ready"); setInterval(()=>{},1000)',
    async (event) => {
      if (event.kind === "stdout") {
        blocked.resolve();
        await new Promise<void>(() => {});
      }
    },
    { timeoutMs: mode === "timeout" ? 200 : 10_000 },
    controller.signal,
  );
  await blocked.promise;
  if (mode === "cancel") controller.abort();
  expect(await result).toMatchObject({ outcome: mode === "timeout" ? "timedOut" : "cancelled" });
});

it("enforces four concurrent executions and reports queued before starting the fifth", async () => {
  const started = deferred<void>();
  const queued = deferred<void>();
  const fifthStarted = deferred<void>();
  const controllers = Array.from({ length: 5 }, () => new AbortController());
  let starts = 0;
  const calls = controllers.map((controller) =>
    execute(
      "setInterval(()=>{},1000)",
      async (event) => {
        if (event.kind !== "progress") return;
        const progress = JSON.parse(event.data);
        if (progress.type === "started") {
          starts++;
          if (starts === 4) started.resolve();
          if (starts === 5) fifthStarted.resolve();
        }
        if (progress.type === "queued") queued.resolve();
      },
      {},
      controller.signal,
    ),
  );
  await Promise.all([started.promise, queued.promise]);
  expect(starts).toBe(4);
  const status = decodeStatus(
    await service.handlers.status!({
      request: { ...request(""), input: {} },
      environmentId: "env",
      emit: async () => {},
      signal: new AbortController().signal,
    }),
  );
  expect(status.running).toBe(4);
  expect(status.grant).toBe("granted");
  controllers[0]!.abort();
  await calls[0];
  await fifthStarted.promise;
  await service.disconnectAll();
  expect(
    (await Promise.all(calls)).every((result) => decodeResult(result).outcome === "cancelled"),
  ).toBe(true);
});

it.each([0, 5])("runs a private-daemon mutagen sync barrier, exit %s", async (code) => {
  config = {
    ...config,
    mappings: [{ serverPath: "/work", winPath: "C:\\work", syncSession: "test-session" }],
  };
  const marker = NodePath.join(dir, "flushed");
  syncEnvironment = async () => ({
    T3_MUTAGEN_EXE: NodePath.join(dir, "mutagen"),
    T3_MUTAGEN_DATA_DIRECTORY: NodePath.join(dir, "private-data"),
  });
  await NodeFSP.writeFile(
    NodePath.join(dir, "mutagen"),
    `#!${process.execPath}\n${pipeOutput}require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.argv.slice(2).join(' ') + '|' + process.env.MUTAGEN_DATA_DIRECTORY + '|' + process.env.MUTAGEN_DISABLE_AUTOSTART); process.stderr.write('sync diagnostic'); process.exitCode=${code};\n`,
    { mode: 0o755 },
  );
  const events: Event[] = [];
  const operation = execute(
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(marker)},'utf8'))`,
    async (e) => {
      events.push(e);
    },
    { winCwd: "c:\\WORK", env: { PATH: `${dir}${NodePath.delimiter}${process.env.PATH}` } },
  );
  if (code)
    await expect(operation).rejects.toMatchObject({
      code: "SYNC_FAILED",
      message: expect.stringContaining("sync diagnostic"),
    });
  else {
    expect(await operation).toMatchObject({ outcome: "exited" });
    expect(events.find((e) => e.kind === "stdout")?.data).toBe(
      `sync flush test-session|${NodePath.join(dir, "private-data")}|1`,
    );
  }
  expect(events.find((e) => e.kind === "progress")?.data).toBe(
    JSON.stringify({ type: "syncing", session: "test-session" }),
  );
  expect(await execute("", undefined, { noSync: true })).toMatchObject({ outcome: "exited" });
  const log = await service.handlers.log!({
    request: { ...request(""), input: { limit: 20 } },
    environmentId: "env",
    signal: new AbortController().signal,
    emit: async () => {},
  });
  expect(decodeLog(log).entries).toHaveLength(2);
});

it("writes PowerShell as BOM UTF-8 with the encoding prelude, cleans up and caches shell discovery", async () => {
  const originalPath = process.env.PATH;
  const shell = NodePath.join(dir, "pwsh");
  await NodeFSP.writeFile(
    shell,
    `#!${process.execPath}\n${pipeOutput}const fs=require('node:fs'); const args=process.argv.slice(2); const file=args[args.length-1]; const bytes=fs.readFileSync(file); process.stdout.write(JSON.stringify({args, bom:bytes.subarray(0,3).toString('hex'), text:bytes.subarray(3).toString('utf8')}));`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${dir}${NodePath.delimiter}${originalPath}`);
  try {
    const first = await service.getCapabilities();
    expect(first.exec?.shells).toContain(shell);
    vi.stubEnv("PATH", "");
    expect(await service.getCapabilities()).toEqual(first);
    const events: Event[] = [];
    const result = await execute(
      "",
      async (event) => {
        events.push(event);
      },
      { mode: "powershell", script: "if ($true) {\n Write-Output '中文'\n}" },
    );
    expect(result).toMatchObject({ outcome: "exited", exitCode: 0 });
    const output = JSON.parse(
      events
        .filter((event) => event.kind === "stdout")
        .map((event) => event.data)
        .join(""),
    );
    expect(output.bom).toBe("efbbbf");
    expect(output.args.slice(0, -1)).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
    ]);
    expect(output.text).toBe(
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8\r\nif ($true) {\n Write-Output '中文'\n}",
    );
    await expect(NodeFSP.stat(output.args.at(-1))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
  }
});

it("injects only public sync variables for the requesting environment", async () => {
  const seen: string[] = [];
  syncEnvironment = async (environmentId) => {
    seen.push(environmentId);
    return {
      T3_MUTAGEN_EXE: "/isolated/mutagen",
      T3_MUTAGEN_DATA_DIRECTORY: "/isolated/data",
      T3_SYNC_HOST: "t3-requester",
    };
  };
  let output = "";
  const script =
    'process.stdout.write([process.env.T3_MUTAGEN_EXE,process.env.T3_MUTAGEN_DATA_DIRECTORY,process.env.T3_SYNC_HOST,process.env.T3_SYNC_RELAY_TOKEN,process.env.MUTAGEN_SSH_PATH,process.env.MUTAGEN_DATA_DIRECTORY].join("|"))';
  await execute(script, async (event) => {
    if (event.kind === "stdout") output += event.data;
  });
  expect(seen).toEqual(["env"]);
  expect(output).toBe("/isolated/mutagen|/isolated/data|t3-requester|||");
  syncEnvironment = undefined;
  output = "";
  await execute(script, async (event) => {
    if (event.kind === "stdout") output += event.data;
  });
  expect(output).toBe("|||||");
});

const linkedRecord = {
  id: "91d581f4-d87a-4efe-967c-2b60314575bb",
  environmentId: "env",
  projectId: "project",
  hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
  serverPath: "/work",
  winPath: "C:\\work",
  syncSession: "t3-link-91d581f4",
  paused: false,
  createdAt: "2026-11-14T00:00:00.000Z",
} as import("@t3tools/contracts").DesktopLinkedFolder;
const linkedContext = {
  ...request("").context,
  projectId: linkedRecord.projectId,
  workspaceRoot: "/work",
  linkedHostId: linkedRecord.hostId,
};
const setupLinked = async () => {
  await store.revokeGrant({ environmentId: "env", threadId: "thread" });
  config = { ...config, hostId: linkedRecord.hostId, linkedProjects: [linkedRecord] };
};
const invokeLinked = (
  context = linkedContext,
  extra = {},
  emit: (event: Event) => Promise<void> = async () => {},
) =>
  service.handlers.exec!({
    request: { ...request("", extra), context },
    environmentId: "env",
    signal: new AbortController().signal,
    emit,
  });
it("linked exec creates no thread grants, audits linked, and status/log remain observational", async () => {
  await setupLinked();
  const { linkedHostId: _linkedHostId, ...withoutHost } = linkedContext;
  await invokeLinked(withoutHost as typeof linkedContext);
  expect(store.listGrants()).toEqual([]);
  expect(store.getPendingGrantRequests()).toEqual([]);
  expect((await store.readAudit({ limit: 1 }))[0]?.authorization).toBe("linked");
  const ctx = {
    request: { ...request(""), context: linkedContext, input: {} },
    environmentId: "env",
    signal: new AbortController().signal,
    emit: async () => {},
  };
  expect(await service.handlers.status!(ctx)).toMatchObject({ grant: "linked" });
  expect(
    await service.handlers.log!({ ...ctx, request: { ...ctx.request, input: { limit: 1 } } }),
  ).toMatchObject({ entries: [expect.objectContaining({ authorization: "linked" })] });
  config = { ...config, enabledEnvironmentIds: [] };
  await expect(invokeLinked()).rejects.toMatchObject({ code: "REMOTE_DISABLED" });
  expect(await service.handlers.status!(ctx)).toMatchObject({ enabled: false, grant: "linked" });
  expect(
    await service.handlers.log!({ ...ctx, request: { ...ctx.request, input: { limit: 1 } } }),
  ).toMatchObject({ entries: expect.any(Array) });
});
it.each([
  "environment",
  "record",
  "project",
  "root",
  "missing-project",
  "missing-root",
  "host",
  "cwd",
  "strict",
])("falls back to the original prompt for invalid linked condition: %s", async (condition) => {
  await setupLinked();
  let context: import("@t3tools/contracts").DesktopChannelRequestContext = linkedContext;
  if (condition === "record") config = { ...config, linkedProjects: [] };
  if (condition === "environment")
    config = {
      ...config,
      linkedProjects: [{ ...linkedRecord, environmentId: EnvironmentId.make("other") }],
    };
  if (condition === "project") context = { ...context, projectId: ProjectId.make("other") };
  if (condition === "root") context = { ...context, workspaceRoot: "/other" };
  if (condition === "missing-project") {
    const { projectId: _projectId, ...rest } = context;
    context = rest;
  }
  if (condition === "missing-root") {
    const { workspaceRoot: _workspaceRoot, ...rest } = context;
    context = rest;
  }
  if (condition === "host") context = { ...context, linkedHostId: "other" };
  if (condition === "strict") config = { ...config, strictMode: true };
  if (condition === "cwd") config = { ...config, allowlist: ["D:\\outside"] };
  const pending = deferred<void>();
  const operation = invokeLinked(
    context as typeof linkedContext,
    condition === "cwd" ? { winCwd: "D:\\outside" } : {},
    async (event) => {
      if (event.kind === "progress" && JSON.parse(event.data).type === "awaiting-grant")
        pending.resolve();
    },
  );
  const rejection = expect(operation).rejects.toMatchObject({ code: "GRANT_DENIED" });
  await pending.promise;
  await store.resolveGrant({
    grantRequestId: store.getPendingGrantRequests()[0]!.grantRequestId,
    decision: "deny",
  });
  await rejection;
  expect(store.listGrants()).toEqual([]);
  if (condition === "strict") {
    config = { ...config, strictMode: false };
    await expect(invokeLinked()).rejects.toMatchObject({ code: "GRANT_DENIED" });
  }
});
it.each(["missing", "paused"])(
  "skips private flush when %s without invoking PATH mutagen",
  async (reason) => {
    config = {
      ...config,
      mappings: [
        { serverPath: "/work", winPath: "C:\\work", syncSession: linkedRecord.syncSession },
      ],
      linkedProjects: [{ ...linkedRecord, paused: reason === "paused" }],
    };
    await NodeFSP.writeFile(NodePath.join(dir, "mutagen"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    syncEnvironment =
      reason === "paused"
        ? async () => ({
            T3_MUTAGEN_EXE: NodePath.join(dir, "mutagen"),
            T3_MUTAGEN_DATA_DIRECTORY: dir,
          })
        : async () => ({});
    const events: Event[] = [];
    expect(
      await execute(
        "",
        async (event) => {
          events.push(event);
        },
        {
          env: {
            PATH: `${dir}${NodePath.delimiter}${process.env.PATH}`,
            T3_MUTAGEN_EXE: NodePath.join(dir, "mutagen"),
            T3_MUTAGEN_DATA_DIRECTORY: dir,
          },
        },
      ),
    ).toMatchObject({ exitCode: 0 });
    if (reason === "missing")
      expect(events.some((event) => event.data.includes("sync-skipped"))).toBe(true);
    expect(events.some((event) => event.data.includes('"type":"syncing"'))).toBe(false);
  },
);

it.each([false, true])(
  "status/log never authorize with the environment disabled (strict=%s)",
  async (strictMode) => {
    await setupLinked();
    config = { ...config, enabledEnvironmentIds: [], strictMode };
    const authorize = vi.spyOn(store, "authorize");
    const ctx = {
      request: { ...request(""), context: linkedContext, input: {} },
      environmentId: "env",
      signal: new AbortController().signal,
      emit: vi.fn(async () => {}),
    };
    expect(await service.handlers.status!(ctx)).toMatchObject({
      enabled: false,
      strictMode,
      grant: strictMode ? "none" : "linked",
      allowlist: [linkedRecord.winPath],
      mappings: expect.arrayContaining([
        {
          serverPath: linkedRecord.serverPath,
          winPath: linkedRecord.winPath,
          syncSession: linkedRecord.syncSession,
        },
      ]),
    });
    expect(
      await service.handlers.log!({ ...ctx, request: { ...ctx.request, input: { limit: 1 } } }),
    ).toEqual({ entries: [] });
    expect(authorize).not.toHaveBeenCalled();
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(store.getPendingGrantRequests()).toEqual([]);
  },
);
it("status falls back to the existing grant on unmapped workspaces, and log needs no mapping", async () => {
  const authorize = vi.spyOn(store, "authorize");
  const ctx = {
    request: {
      ...request(""),
      context: { ...linkedContext, workspaceRoot: "/unmapped" },
      input: {},
    },
    environmentId: "env",
    signal: new AbortController().signal,
    emit: async () => {},
  };
  expect(await service.handlers.status!(ctx)).toMatchObject({ enabled: true, grant: "granted" });
  expect(
    await service.handlers.log!({ ...ctx, request: { ...ctx.request, input: { limit: 1 } } }),
  ).toEqual({ entries: [] });
  expect(authorize).not.toHaveBeenCalled();
});

describe("Windows process cleanup", () => {
  function fixture() {
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      pid: 1234,
      stdout: new NodeStream.PassThrough(),
      stderr: new NodeStream.PassThrough(),
      kill: vi.fn(() => true),
      unref: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const killer = Object.assign(new NodeEvents.EventEmitter(), {
      kill: vi.fn(() => true),
      unref: vi.fn(),
      exitCode: null,
      signalCode: null,
    });
    const spawn = vi.fn(
      (command: string) =>
        (command === "taskkill.exe" ? killer : child) as unknown as NodeChildProcess.ChildProcess,
    );
    spawnOverride.run = spawn;
    const controller = new AbortController();
    const result = runProcess({
      platform: "win32",
      executable: "program.exe",
      args: [],
      cwd: dir,
      winCwd: "C:\\work",
      env: {},
      timeoutMs: 60_000,
      signal: controller.signal,
      emit: async () => {},
    });
    child.emit("spawn");
    return { child, killer, spawn, controller, result };
  }

  it.each(["nonzero", "error", "hung"])(
    "falls back to the owned child when taskkill is %s",
    async (failure) => {
      vi.useFakeTimers();
      try {
        const f = fixture();
        f.controller.abort();
        expect(f.spawn).toHaveBeenLastCalledWith(
          "taskkill.exe",
          ["/T", "/F", "/PID", "1234"],
          expect.objectContaining({ windowsHide: true }),
        );
        if (failure === "nonzero") f.killer.emit("exit", 1);
        if (failure === "error") f.killer.emit("error", new Error("taskkill unavailable"));
        if (failure === "hung") await vi.advanceTimersByTimeAsync(2_000);
        expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
        f.child.emit("close", null);
        expect(await f.result).toMatchObject({ outcome: "cancelled", exitCode: null });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        spawnOverride.run = undefined;
        vi.useRealTimers();
      }
    },
  );

  it("records and reports cleanup failure even when the execution was cancelled", async () => {
    vi.useFakeTimers();
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        pid: 1234,
        stdout: new NodeStream.PassThrough(),
        stderr: new NodeStream.PassThrough(),
        kill: vi.fn(() => true),
        unref: vi.fn(),
      });
      spawnOverride.run = () => {
        queueMicrotask(() => child.emit("spawn"));
        return child as unknown as NodeChildProcess.ChildProcess;
      };
      const started = deferred<void>();
      const controller = new AbortController();
      const pending = execute(
        "",
        async (event) => {
          if (event.kind === "progress" && decodeProgress(event.data).type === "started")
            started.resolve();
        },
        {},
        controller.signal,
      );
      const failure = expect(pending).rejects.toMatchObject({ code: "CLEANUP_FAILED" });
      await started.promise;
      controller.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(await store.readAudit({ limit: 1 })).toMatchObject([
        { outcome: "error", errorCode: "CLEANUP_FAILED", finishedAt: expect.any(String) },
      ]);
    } finally {
      spawnOverride.run = undefined;
      kill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("finishes with unknown process state within ten seconds when close never arrives", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      const failure = expect(f.result).rejects.toMatchObject({
        code: "CLEANUP_FAILED",
        message: expect.stringContaining("state is unknown"),
      });
      f.controller.abort();
      f.killer.emit("exit", 1);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(f.child.unref).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await failure;
      expect(f.child.unref).toHaveBeenCalledOnce();
      expect(f.child.stdout.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      spawnOverride.run = undefined;
      vi.useRealTimers();
    }
  });
});
