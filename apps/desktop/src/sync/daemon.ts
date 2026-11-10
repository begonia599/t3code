// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Own native child handles and shutdown deadlines.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type SyncPaths = { executable: string; shimDirectory: string; dataDirectory: string };
export async function findSyncPaths(options: {
  resourcesPath: string;
  userData: string;
  platform: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}): Promise<SyncPaths | undefined> {
  const env = options.env ?? process.env;
  const extension = options.platform === "win32" ? ".exe" : "";
  const directory = NodePath.join(options.resourcesPath, "mutagen");
  const executable = NodePath.resolve(
    env.T3CODE_SYNC_MUTAGEN_EXE ?? NodePath.join(directory, `mutagen${extension}`),
  );
  const shimDirectory = NodePath.resolve(env.T3CODE_SYNC_SSH_PATH ?? directory);
  for (const path of [
    executable,
    ...["ssh", "scp"].map((name) => NodePath.join(shimDirectory, name + extension)),
  ]) {
    try {
      if (!(await NodeFSP.stat(path)).isFile()) return undefined;
      await NodeFSP.access(
        path,
        options.platform === "win32" ? NodeFS.constants.F_OK : NodeFS.constants.X_OK,
      );
    } catch {
      return undefined;
    }
  }
  return { executable, shimDirectory, dataDirectory: NodePath.join(options.userData, "mutagen") };
}

export function daemonEnvironment(paths: SyncPaths, relay: { address: string; token: string }) {
  return {
    ...process.env,
    MUTAGEN_DATA_DIRECTORY: paths.dataDirectory,
    MUTAGEN_SSH_PATH: paths.shimDirectory,
    T3_SYNC_RELAY_ADDR: relay.address,
    T3_SYNC_RELAY_TOKEN: relay.token,
  };
}

/** All signals target children captured at NodeChildProcess.spawn, never a PID discovered by process matching. */
export async function startDaemon(
  paths: SyncPaths,
  relay: { address: string; token: string },
  options: {
    restartDelays?: readonly number[];
    onUnavailable?: () => void;
  } = {},
) {
  await NodeFSP.mkdir(paths.dataDirectory, { recursive: true });
  const env = daemonEnvironment(paths, relay);
  const stopCommand = () =>
    new Promise<void>((resolve, reject) => {
      const child = NodeChildProcess.spawn(paths.executable, ["daemon", "stop"], {
        env,
        windowsHide: true,
        stdio: "ignore",
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 5000);
      child.once("error", reject);
      child.once("close", () => {
        clearTimeout(timer);
        if (timedOut) reject(new Error("Mutagen daemon stop timed out"));
        else resolve();
      });
    });
  // A previous daemon owns a stale relay token, even if its IPC endpoint is healthy.
  await stopCommand();
  let stopping = false;
  let attempts = 0;
  let restart: ReturnType<typeof setTimeout> | undefined;
  const delays = options.restartDelays ?? [1000, 2000, 4000];
  let current: ReturnType<typeof launch>;
  function launch() {
    const child = NodeChildProcess.spawn(paths.executable, ["daemon", "run"], {
      env,
      windowsHide: true,
      stdio: "ignore",
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => {
        resolve();
        if (stopping) return;
        const delay = delays[attempts++];
        if (delay === undefined) {
          options.onUnavailable?.();
          return;
        }
        restart = setTimeout(() => {
          restart = undefined;
          current = launch();
          void current.ready.catch(() => {});
        }, delay);
      }),
    );
    return { child, ready, closed };
  }
  current = launch();
  let shutdown: Promise<void> | undefined;
  const stop = () =>
    (shutdown ??= (async () => {
      stopping = true;
      if (restart) clearTimeout(restart);
      const owned = current;
      // One shared five-second deadline covers both stop RPC and daemon exit.
      const timer = setTimeout(() => owned.child.kill("SIGKILL"), 5000);
      try {
        await stopCommand();
      } finally {
        await owned.closed;
        clearTimeout(timer);
      }
    })());
  try {
    await current.ready;
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }
  return {
    env,
    stop,
    get pid() {
      return current.child.pid;
    },
    get running() {
      return !stopping && current.child.exitCode === null && current.child.signalCode === null;
    },
  };
}
