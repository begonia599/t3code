// @effect-diagnostics nodeBuiltinImport:off -- Opt-in test owns its private daemon, tunnel and native filesystem fixtures.
import * as Context from "effect/Context";
import { HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { EnvironmentId, ProjectId, type DesktopLinkedFolder } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { createLinkedSync, runMutagen } from "./LinkedSync.ts";
import { createLinkedProjects } from "./LinkedProjects.ts";
import { DEFAULT_DESKTOP_SETTINGS } from "../settings/DesktopAppSettings.ts";
import { startDaemon } from "./daemon.ts";
import { startRelay } from "./relay.ts";
import { startE2eServer } from "./e2eServer.ts";
import { syncHost } from "./protocol.ts";

it.skipIf(process.env.T3CODE_SYNC_E2E !== "1")(
  "LinkedSync real Mutagen 0.18.1: ignores, conflicts both directions, pause/resume and terminate over the tunnel",
  async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-linked-e2e-"));
    const cleanup: Array<() => Promise<unknown>> = [];
    const vendor =
      process.env.T3CODE_SYNC_E2E_VENDOR ?? "/home/dev/opt/t3-win-desktop/spike-mutagen/vendor";
    const go = process.env.T3CODE_SYNC_E2E_GO ?? "/home/dev/.local/opt/go1.27.3/bin/go";
    const executable = NodePath.join(root, "client", "mutagen");
    const shimDirectory = NodePath.join(root, "shims");
    const dataDirectory = NodePath.join(root, "data");
    const alpha = NodePath.join(root, "alpha");
    const beta = NodePath.join(root, "beta");
    const agentDirectory = NodePath.join(root, "agents");
    const record: DesktopLinkedFolder = {
      id: "91d581f4-d87a-4efe-967c-2b60314575bb",
      hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
      environmentId: EnvironmentId.make("linked-e2e"),
      projectId: ProjectId.make("project"),
      serverPath: beta,
      winPath: alpha,
      syncSession: "t3-link-91d581f4",
      paused: false,
      createdAt: "2026-11-14T00:00:00Z",
    };
    try {
      for (const directory of [
        NodePath.dirname(executable),
        shimDirectory,
        alpha,
        beta,
        agentDirectory,
      ])
        await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.copyFile(NodePath.join(vendor, "mutagen", "mutagen"), executable);
      await NodeFSP.chmod(executable, 0o755);
      expect((await runMutagen(executable, ["version"], process.env)).trim()).toBe("0.18.1");
      const architecture =
        Context.get(Context.empty(), HostProcessArchitecture) === "arm64" ? "arm64" : "amd64";
      await runMutagen(
        go,
        [
          "build",
          "-C",
          NodePath.resolve(import.meta.dirname, "../../../../native/sync-ssh-shim"),
          "-trimpath",
          "-o",
          NodePath.join(shimDirectory, "ssh"),
          ".",
        ],
        {
          ...process.env,
          GOTOOLCHAIN: "local",
          GOFLAGS: "-buildvcs=false",
          GOCACHE: "/tmp/codex-gocache",
          GOPATH: "/tmp/codex-gopath",
          GOOS: "linux",
          GOARCH: architecture,
        },
      );
      await NodeFSP.copyFile(
        NodePath.join(shimDirectory, "ssh"),
        NodePath.join(shimDirectory, "scp"),
      );
      await runMutagen(
        "tar",
        [
          "-xzf",
          NodePath.join(vendor, "mutagen", "mutagen-agents.tar.gz"),
          "-C",
          agentDirectory,
          `linux_${architecture}`,
        ],
        process.env,
      );
      const agentPath = NodePath.join(agentDirectory, `linux_${architecture}`);
      await NodeFSP.chmod(agentPath, 0o755);
      const server = await startE2eServer(root, agentPath);
      cleanup.push(server.stop);
      const relay = await startRelay(async (alias) => {
        if (alias !== syncHost(record.environmentId)) throw new Error("Unknown host");
        return { httpBaseUrl: server.url, token: server.token };
      });
      cleanup.push(relay.stop);
      const daemon = await startDaemon({ executable, shimDirectory, dataDirectory }, relay);
      cleanup.push(daemon.stop);
      const environment = async () => ({
        T3_MUTAGEN_EXE: executable,
        T3_MUTAGEN_DATA_DIRECTORY: dataDirectory,
      });
      const sync = createLinkedSync({ environment, privateEnvironment: environment });
      let records: readonly DesktopLinkedFolder[] = [record];
      const projects = createLinkedProjects({
        getConfig: async () => ({
          ...DEFAULT_DESKTOP_SETTINGS.remoteControl,
          hostId: record.hostId,
          linkedProjects: records,
        }),
        setRecords: async (next) => {
          records = next;
        },
        sync,
      });
      const flush = async () => {
        await sync.flush(record);
      };
      const status = async () => (await sync.refresh(records))[0]!;
      const waitState = async (state: string) =>
        expect
          .poll(async () => (await status()).state, { interval: 100, timeout: 20_000 })
          .toBe(state);
      // Keep the roots populated during conflict deletion to avoid Mutagen's root-emptying halt.
      await NodeFSP.mkdir(NodePath.join(alpha, "keep-root"));
      await NodeFSP.writeFile(NodePath.join(alpha, "a.txt"), "initial");
      await NodeFSP.mkdir(NodePath.join(alpha, "node_modules"));
      await NodeFSP.writeFile(NodePath.join(alpha, "node_modules", "x.js"), "ignored");
      await NodeFSP.mkdir(NodePath.join(alpha, ".git"));
      await NodeFSP.writeFile(NodePath.join(alpha, ".git", "HEAD"), "ignored");
      await sync.create(record);
      await flush();
      await waitState("synced");
      expect((await NodeFSP.readdir(beta)).sort()).toEqual(["a.txt", "keep-root"]);
      expect(await NodeFSP.readFile(NodePath.join(beta, "a.txt"), "utf8")).toBe("initial");
      const conflict = async (version: string) => {
        await sync.pause(record);
        await NodeFSP.writeFile(NodePath.join(alpha, "a.txt"), `windows-${version}`);
        await NodeFSP.writeFile(NodePath.join(beta, "a.txt"), `server-${version}`);
        await sync.resume(record);
        await flush();
        await waitState("conflicts");
        expect((await status()).conflicts.map((conflict) => conflict.path)).toEqual(["a.txt"]);
      };
      await conflict("one");
      await projects.resolveConflict({ id: record.id, path: "a.txt", keep: "server" });
      await waitState("synced");
      expect(await NodeFSP.readFile(NodePath.join(alpha, "a.txt"), "utf8")).toBe("server-one");
      expect((await status()).conflicts).toEqual([]);
      await conflict("two");
      await NodeFSP.unlink(NodePath.join(beta, "a.txt"));
      await projects.flush(record.id);
      await waitState("synced");
      expect(await NodeFSP.readFile(NodePath.join(alpha, "a.txt"), "utf8")).toBe("windows-two");
      expect(await NodeFSP.readFile(NodePath.join(beta, "a.txt"), "utf8")).toBe("windows-two");
      await sync.pause(record);
      records = [{ ...record, paused: true }];
      expect((await sync.refresh(records))[0]?.state).toBe("paused");
      records = [record];
      await sync.resume(record);
      await flush();
      await waitState("synced");
      await sync.terminate(record);
      expect(await sync.sessions(record.environmentId)).toEqual([]);
    } finally {
      try {
        for (const stop of cleanup.toReversed()) await stop();
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    }
  },
  120_000,
);
