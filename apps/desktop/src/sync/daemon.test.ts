// @effect-diagnostics nodeBuiltinImport:off -- Isolated native process fixtures exercise lifecycle ownership.
import * as NodeEvents from "node:events";
import type * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { daemonEnvironment, findSyncPaths, startDaemon } from "./daemon.ts";
const spawnOverride = vi.hoisted(() => ({
  run: undefined as
    | ((...args: Parameters<typeof NodeChildProcess.spawn>) => NodeChildProcess.ChildProcess)
    | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) =>
      spawnOverride.run ? spawnOverride.run(...args) : original.spawn(...args),
  };
});
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).toReversed()) await stop();
});
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sync-manager-"));
  cleanup.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  const resourcesPath = NodePath.join(directory, "resources");
  const bin = NodePath.join(resourcesPath, "mutagen");
  await NodeFSP.mkdir(bin, { recursive: true });
  return { directory, resourcesPath, bin };
}
it("silently disables missing resources and resolves explicit development overrides", async () => {
  const f = await fixture();
  const options = {
    resourcesPath: f.resourcesPath,
    userData: f.directory,
    platform: "linux" as const,
    env: {},
  };
  expect(await findSyncPaths(options)).toBeUndefined();
  for (const name of ["mutagen", "ssh", "scp"])
    await NodeFSP.writeFile(NodePath.join(f.bin, name), "fixture", { mode: 0o755 });
  const paths = await findSyncPaths(options);
  expect(paths).toEqual({
    executable: NodePath.join(f.bin, "mutagen"),
    shimDirectory: f.bin,
    dataDirectory: NodePath.join(f.directory, "mutagen"),
  });
  expect(
    await findSyncPaths({
      ...options,
      resourcesPath: "/missing",
      env: { T3CODE_SYNC_MUTAGEN_EXE: paths!.executable, T3CODE_SYNC_SSH_PATH: f.bin },
    }),
  ).toEqual(paths);
  expect(daemonEnvironment(paths!, { address: "127.0.0.1:1234", token: "private" })).toMatchObject({
    MUTAGEN_DATA_DIRECTORY: paths!.dataDirectory,
    MUTAGEN_SSH_PATH: f.bin,
    T3_SYNC_RELAY_TOKEN: "private",
  });
});
it("stops stale state, bounds restart attempts and reaps each owned daemon", async () => {
  const f = await fixture();
  const executable = NodePath.join(f.bin, "mutagen");
  // Deliberately failing daemon: append is synchronous, so close is the completion receipt.
  await NodeFSP.writeFile(
    executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const path=require('node:path');fs.appendFileSync(path.join(process.env.MUTAGEN_DATA_DIRECTORY,'calls'),process.argv.slice(2).join(' ')+'|'+process.env.T3_SYNC_RELAY_TOKEN+'|'+process.pid+'\\n');process.exitCode=process.argv[3]==='run'?1:0;`,
    { mode: 0o755 },
  );
  let exhausted!: () => void;
  const unavailable = new Promise<void>((resolve) => {
    exhausted = resolve;
  });
  const dataDirectory = NodePath.join(f.directory, "data");
  const manager = await startDaemon(
    { executable, shimDirectory: f.bin, dataDirectory },
    { address: "127.0.0.1:1234", token: "new-token" },
    { restartDelays: [1, 1], onUnavailable: exhausted },
  );
  cleanup.push(manager.stop);
  await unavailable;
  expect(manager.running).toBe(false);
  await manager.stop();
  const lines = (await NodeFSP.readFile(NodePath.join(dataDirectory, "calls"), "utf8"))
    .trim()
    .split("\n");
  expect(lines.map((line) => line.split("|")[0])).toEqual([
    "daemon stop",
    "daemon run",
    "daemon run",
    "daemon run",
    "daemon stop",
  ]);
  expect(lines.every((line) => line.split("|")[1] === "new-token")).toBe(true);
  for (const line of lines) expect(() => process.kill(Number(line.split("|")[2]), 0)).toThrow();
});

it("force kills and reaps its daemon when stop returns without shutting it down", async () => {
  const f = await fixture();
  const executable = NodePath.join(f.bin, "mutagen");
  await NodeFSP.writeFile(
    executable,
    `#!${process.execPath}\nif(process.argv[3]==='run') setInterval(()=>{},1000);`,
    { mode: 0o755 },
  );
  const manager = await startDaemon(
    { executable, shimDirectory: f.bin, dataDirectory: NodePath.join(f.directory, "data") },
    { address: "127.0.0.1:1234", token: "private" },
  );
  cleanup.push(manager.stop);
  const pid = manager.pid!;
  await manager.stop();
  expect(manager.running).toBe(false);
  expect(() => process.kill(pid, 0)).toThrow();
});

function mockDaemon() {
  const runs: Array<ReturnType<typeof child>> = [];
  function child() {
    const process = Object.assign(new NodeEvents.EventEmitter(), {
      pid: 1234,
      exitCode: null as number | null,
      signalCode: null,
      kill: vi.fn(() => true),
    });
    return process;
  }
  spawnOverride.run = (_file, args) => {
    const process = child();
    queueMicrotask(() => {
      process.emit("spawn");
      if (args?.[1] === "stop") {
        for (const run of runs)
          if (run.exitCode === null) {
            run.exitCode = 0;
            run.emit("close", 0);
          }
        process.exitCode = 0;
        process.emit("close", 0);
      }
    });
    if (args?.[1] === "run") runs.push(process);
    return process as unknown as NodeChildProcess.ChildProcess;
  };
  const crash = () => {
    const run = runs.at(-1)!;
    run.exitCode = 1;
    run.emit("close", 1);
  };
  return { runs, crash };
}

it("resets the restart budget after sixty seconds of stable running", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const native = mockDaemon();
  let manager: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const unavailable = vi.fn();
    manager = await startDaemon(
      { executable: "mutagen", shimDirectory: f.bin, dataDirectory: f.directory },
      { address: "local", token: "test" },
      { onUnavailable: unavailable },
    );
    for (const delay of [1_000, 2_000, 4_000]) {
      native.crash();
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(native.runs).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(60_000);
    native.crash();
    await vi.advanceTimersByTimeAsync(999);
    expect(native.runs).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(native.runs).toHaveLength(5);
    expect(unavailable).not.toHaveBeenCalled();
  } finally {
    await manager?.stop();
    expect(vi.getTimerCount()).toBe(0);
    spawnOverride.run = undefined;
    vi.useRealTimers();
  }
});

it("keeps retrying every sixty seconds after exhausting the fast restart budget", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  const native = mockDaemon();
  let manager: Awaited<ReturnType<typeof startDaemon>> | undefined;
  try {
    const unavailable = vi.fn();
    manager = await startDaemon(
      { executable: "mutagen", shimDirectory: f.bin, dataDirectory: f.directory },
      { address: "local", token: "test" },
      { onUnavailable: unavailable },
    );
    for (const delay of [1_000, 2_000, 4_000]) {
      native.crash();
      await vi.advanceTimersByTimeAsync(delay);
    }
    for (let i = 0; i < 2; i++) {
      native.crash();
      expect(manager.running).toBe(false);
      expect(unavailable).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(native.runs).toHaveLength(4 + i);
      await vi.advanceTimersByTimeAsync(1);
      expect(native.runs).toHaveLength(5 + i);
      expect(manager.running).toBe(true);
    }
  } finally {
    await manager?.stop();
    expect(vi.getTimerCount()).toBe(0);
    spawnOverride.run = undefined;
    vi.useRealTimers();
  }
});
