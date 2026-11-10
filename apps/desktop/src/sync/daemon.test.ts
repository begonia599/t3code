// @effect-diagnostics nodeBuiltinImport:off -- Isolated native process fixtures exercise lifecycle ownership.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { daemonEnvironment, findSyncPaths, startDaemon } from "./daemon.ts";
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
