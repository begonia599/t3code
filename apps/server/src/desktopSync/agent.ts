// @effect-diagnostics nodeBuiltinImport:off globalTimers:off instanceOfSchema:off - spawns a detached POSIX process group, which Effect's ChildProcess does not expose.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  MUTAGEN_VERSION,
  DESKTOP_SYNC_TERMINATE_GRACE_MS,
  DesktopSyncErrorCode,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class TunnelError extends Schema.TaggedError<TunnelError>()("DesktopSyncTunnelError", {
  code: DesktopSyncErrorCode,
  message: Schema.String,
}) {}

/** Start only the server-selected executable, with no shell or inherited server credentials. */
export const startAgent = Effect.fn("DesktopSync.startAgent")(function* (args: readonly string[]) {
  const platform = yield* HostProcessPlatform;
  return yield* Effect.try({
    try: () => {
      if (platform === "win32") {
        throw new TunnelError({
          code: "SPAWN_FAILED",
          message: "Synchronization tunnels require a POSIX server process group.",
        });
      }
      const home = process.env.HOME || NodeOS.homedir();
      const agentPath = NodePath.resolve(
        process.env.T3CODE_MUTAGEN_AGENT_PATH ??
          NodePath.join(home, ".mutagen", "agents", MUTAGEN_VERSION, "mutagen-agent"),
      );
      try {
        NodeFS.accessSync(agentPath, NodeFS.constants.X_OK);
        if (!NodeFS.statSync(agentPath).isFile()) throw new Error("Not a file");
      } catch {
        throw new TunnelError({
          code: "AGENT_MISSING",
          message: "The configured Mutagen agent is missing or not executable.",
        });
      }
      const env: NodeJS.ProcessEnv = { HOME: home };
      for (const key of ["PATH", "LANG", "LC_ALL", "USER", "TMPDIR"]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const child = NodeChildProcess.spawn(agentPath, [...args], {
        cwd: home,
        env,
        detached: true,
        stdio: "pipe",
        shell: false,
      });
      // Register immediately: spawn errors and exit must never become unhandled or be missed.
      const ready = new Promise<Error | undefined>((resolve) => {
        child.once("spawn", () => resolve(undefined));
        child.once("error", resolve);
      });
      const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      // EPIPE can precede the process close receipt. The input pump observes its write callback.
      child.stdin.on("error", () => {});
      let stopping: Promise<void> | undefined;
      const signalGroup = (signal: NodeJS.Signals | 0) => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, signal);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw error;
        }
      };
      const stop = () =>
        (stopping ??= (async () => {
          child.stdin.end();
          // Even after the leader exits, descendants can still own the process group / pipes.
          if (signalGroup("SIGTERM")) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(() => {
                signalGroup("SIGKILL");
                resolve();
              }, DESKTOP_SYNC_TERMINATE_GRACE_MS);
              void closed.then(() => {
                if (!signalGroup(0)) {
                  clearTimeout(timer);
                  resolve();
                }
              });
            });
          }
          await closed;
        })());
      return { child, ready, closed, stop };
    },
    catch: (error) =>
      error instanceof TunnelError
        ? error
        : new TunnelError({
            code: "SPAWN_FAILED",
            message: "Could not start the configured Mutagen agent.",
          }),
  });
});
