// @effect-diagnostics nodeBuiltinImport:off -- Opt-in integration test owns native binaries, processes and isolated state.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { expect, it, vi } from "vite-plus/test";
import { startRelay } from "./relay.ts";
import { startDaemon } from "./daemon.ts";
import { syncHost } from "./protocol.ts";

const children = vi.hoisted(() => [] as NodeChildProcess.ChildProcess[]);
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return {
    ...original,
    spawn: (...args: Parameters<typeof original.spawn>) => {
      const child = original.spawn(...args);
      children.push(child);
      return child;
    },
  };
});
const decodeSessions = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({
        status: Schema.String,
        alpha: Schema.Struct({ connected: Schema.Boolean }),
        beta: Schema.Struct({ connected: Schema.Boolean }),
        successfulCycles: Schema.optionalKey(Schema.Number),
        lastError: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
);

/** Go can spawn from any OS thread; restrict discovery to the owned daemon's tasks. */
async function daemonChildren(pid: number) {
  const children = new Set<number>();
  for (const task of await NodeFSP.readdir(`/proc/${pid}/task`)) {
    const listed = await NodeFSP.readFile(`/proc/${pid}/task/${task}/children`, "utf8").catch(
      () => "",
    );
    for (const child of listed.trim().split(/\s+/).filter(Boolean)) children.add(Number(child));
  }
  return [...children];
}

function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  signal?: AbortSignal,
) {
  return new Promise<string>((resolve, reject) => {
    const child = NodeChildProcess.spawn(executable, args, {
      env,
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      ...(signal ? { signal } : {}),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) =>
      code === 0 && !failure
        ? resolve(stdout)
        : reject(
            failure ??
              new Error(
                `${NodePath.basename(executable)} ${args.slice(0, 2).join(" ")} exited ${code}: ${stderr}`,
              ),
          ),
    );
  });
}

it.skipIf(process.env.T3CODE_SYNC_E2E !== "1")(
  "real Mutagen -> native shim -> relay -> contract tunnel -> real agent, including reconnect",
  async () => {
    expect(Context.get(Context.empty(), HostProcessPlatform)).toBe("linux");
    expect(Context.get(Context.empty(), HostProcessArchitecture)).toBe("arm64");
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sync-e2e-"));
    const cleanup: (() => Promise<unknown>)[] = [];
    const signal = AbortSignal.timeout(90_000);
    const exec = (executable: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string) =>
      run(executable, args, env, cwd, signal);
    children.length = 0;
    const vendor =
      process.env.T3CODE_SYNC_E2E_VENDOR ?? "/home/dev/opt/t3-win-desktop/spike-mutagen/vendor";
    const go = process.env.T3CODE_SYNC_E2E_GO ?? "/home/dev/.local/opt/go1.27.3/bin/go";
    const executable = NodePath.join(root, "client", "mutagen");
    const shimDirectory = NodePath.join(root, "shims");
    const dataDirectory = NodePath.join(root, "data");
    const alpha = NodePath.join(root, "win");
    const mirror = NodePath.join(root, "mirror");
    const remote = Boolean(process.env.T3CODE_SYNC_E2E_SERVER_URL);
    const beta = remote ? `/tmp/${NodePath.basename(root)}-server` : NodePath.join(root, "server");
    const host = syncHost("e2e-environment");
    try {
      for (const directory of [NodePath.dirname(executable), shimDirectory, alpha, mirror])
        await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.copyFile(NodePath.join(vendor, "mutagen", "mutagen"), executable);
      await NodeFSP.chmod(executable, 0o755);
      expect(await NodeFSP.readdir(NodePath.dirname(executable))).toEqual(["mutagen"]);
      await exec(
        go,
        ["build", "-trimpath", "-o", NodePath.join(shimDirectory, "ssh"), "."],
        {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOFLAGS: "-buildvcs=false",
          GOCACHE: "/tmp/codex-gocache",
          GOPATH: "/tmp/codex-gopath",
          GOOS: "linux",
          GOARCH: "arm64",
        },
        NodePath.resolve(import.meta.dirname, "../../../../native/sync-ssh-shim"),
      );
      await NodeFSP.copyFile(
        NodePath.join(shimDirectory, "ssh"),
        NodePath.join(shimDirectory, "scp"),
      );
      let url = process.env.T3CODE_SYNC_E2E_SERVER_URL;
      let token = process.env.T3CODE_SYNC_E2E_BEARER;
      if (remote && !token) throw new Error("T3CODE_SYNC_E2E_BEARER is required with SERVER_URL");
      if (!remote) {
        const agentDir = NodePath.join(root, "preinstalled-agent");
        await NodeFSP.mkdir(agentDir);
        await exec("tar", [
          "-xzf",
          NodePath.join(vendor, "mutagen", "mutagen-agents.tar.gz"),
          "-C",
          agentDir,
          "linux_arm64",
        ]);
        await NodeFSP.chmod(NodePath.join(agentDir, "linux_arm64"), 0o755);
        const { startE2eServer } = await import("./e2eServer.ts");
        const server = await startE2eServer(root, NodePath.join(agentDir, "linux_arm64"));
        cleanup.push(server.stop);
        url = server.url;
        token = server.token;
      }
      let opened = 0;
      let onReconnect = () => {};
      const relay = await startRelay(async (alias) => {
        if (alias !== host) throw new Error("Unknown e2e host");
        opened++;
        onReconnect();
        return { httpBaseUrl: url!, token: token! };
      });
      cleanup.push(relay.stop);
      const daemon = await startDaemon({ executable, shimDirectory, dataDirectory }, relay);
      cleanup.push(daemon.stop);
      const cli = (...args: string[]) => exec(executable, args, daemon.env);
      const waitForSynchronization = (name: string) =>
        expect
          .poll(
            async () => {
              const states = decodeSessions(
                await cli("sync", "list", "--template={{json .}}", name),
              );
              return states.map((state) => ({
                ...state,
                completedCycle: (state.successfulCycles ?? 0) > 0,
              }));
            },
            {
              interval: 100,
              timeout: 45_000,
              message: `${name} must complete a synchronization cycle after reconnect`,
            },
          )
          .toMatchObject([
            {
              status: "watching",
              alpha: { connected: true },
              beta: { connected: true },
              completedCycle: true,
            },
          ]);
      const write = (path: string, data: string | Buffer) => NodeFSP.writeFile(path, data);
      const binary = Buffer.alloc(2 * 1024 * 1024);
      for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
      // Keep a synchronized empty directory so later file cleanup does not trip
      // Mutagen's intentional one-sided root-emptying safety halt.
      await NodeFSP.mkdir(NodePath.join(alpha, "keep-root"));
      await write(NodePath.join(alpha, "initial.bin"), binary);
      await cli(
        "sync",
        "create",
        "--name=e2e",
        "--sync-mode=two-way-safe",
        "--no-global-configuration",
        alpha,
        `${host}:${beta}`,
      );
      await cli("sync", "flush", "e2e");
      if (remote) {
        // A second real client endpoint provides filesystem observations on a remote staging server.
        await cli(
          "sync",
          "create",
          "--name=probe",
          "--sync-mode=two-way-safe",
          "--no-global-configuration",
          `${host}:${beta}`,
          mirror,
        );
        await cli("sync", "flush", "probe");
      }
      const serverFiles = remote ? mirror : beta;
      expect(await NodeFSP.readFile(NodePath.join(serverFiles, "initial.bin"))).toEqual(binary);
      await write(NodePath.join(serverFiles, "from-server.txt"), "server to desktop\n");
      if (remote) await cli("sync", "flush", "probe");
      await cli("sync", "flush", "e2e");
      expect(await NodeFSP.readFile(NodePath.join(alpha, "from-server.txt"), "utf8")).toBe(
        "server to desktop\n",
      );
      await write(NodePath.join(alpha, "from-desktop.txt"), "desktop to server\n");
      await cli("sync", "flush", "e2e");
      if (remote) await cli("sync", "flush", "probe");
      expect(await NodeFSP.readFile(NodePath.join(serverFiles, "from-desktop.txt"), "utf8")).toBe(
        "desktop to server\n",
      );
      // This daemon was captured at spawn. Inspect only its direct children; never
      // match global process names. Validate parent and exact executable before the requested SIGKILL.
      const ownedChildren = await daemonChildren(daemon.pid!);
      const shimPids: number[] = [];
      for (const pid of ownedChildren) {
        const exe = await NodeFSP.readlink(`/proc/${pid}/exe`).catch(() => "");
        const status = await NodeFSP.readFile(`/proc/${pid}/status`, "utf8").catch(() => "");
        if (
          exe === NodePath.join(shimDirectory, "ssh") &&
          status.includes(`PPid:\t${daemon.pid}\n`)
        )
          shimPids.push(pid);
      }
      expect(shimPids.length).toBeGreaterThan(0);
      const prior = opened;
      const reconnected = new Promise<void>((resolve) => {
        onReconnect = () => {
          if (opened > prior) resolve();
        };
      });
      for (const pid of shimPids) process.kill(pid, "SIGKILL");
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error("Timed out waiting for Mutagen reconnect"));
        signal.addEventListener("abort", abort, { once: true });
        void reconnected.then(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        });
        if (signal.aborted) abort();
      });
      // Alias resolution precedes WebSocket open, the agent handshake and scan.
      // Wait on Mutagen's state, then issue one flush; never retry a failed flush.
      await waitForSynchronization("e2e");
      if (remote) await waitForSynchronization("probe");
      await write(NodePath.join(alpha, "after-reconnect.txt"), "reconnected\n");
      await cli("sync", "flush", "e2e");
      if (remote) await cli("sync", "flush", "probe");
      expect(
        await NodeFSP.readFile(NodePath.join(serverFiles, "after-reconnect.txt"), "utf8"),
      ).toBe("reconnected\n");
      // Propagate deletion so staging keeps no test files (its empty directory may remain).
      for (const entry of await NodeFSP.readdir(alpha, { withFileTypes: true }))
        if (entry.isFile()) await NodeFSP.unlink(NodePath.join(alpha, entry.name));
      await cli("sync", "flush", "e2e");
      if (remote) await cli("sync", "flush", "probe");
      expect(await NodeFSP.readdir(serverFiles)).toEqual(["keep-root"]);
      expect(await NodeFSP.readdir(NodePath.join(serverFiles, "keep-root"))).toEqual([]);
      // A second reconnect must not silently mask a broken replacement tunnel.
      expect(opened).toBe(prior + shimPids.length);
      const lastShims = await daemonChildren(daemon.pid!);
      await cli("sync", "terminate", "--all");
      await daemon.stop();
      await relay.stop();
      for (const pid of [...shimPids, ...lastShims]) expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        const failures: unknown[] = [];
        for (const stop of cleanup.toReversed()) {
          try {
            await stop();
          } catch (error) {
            failures.push(error);
          }
        }
        const leaked = children.filter(
          (child) => child.pid && child.exitCode === null && child.signalCode === null,
        );
        for (const child of leaked) {
          const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
          child.kill("SIGKILL");
          await closed;
        }
        expect(leaked).toHaveLength(0);
        expect(failures, "Synchronization cleanup failed").toEqual([]);
        for (const child of children) {
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
          if (child.pid) expect(() => process.kill(child.pid!, 0)).toThrow();
        }
      } finally {
        vi.unstubAllEnvs();
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
