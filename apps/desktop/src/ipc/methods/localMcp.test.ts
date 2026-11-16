// @effect-diagnostics nodeBuiltinImport:off -- Isolated filesystem fixtures for native IPC discovery.
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { LocalMcpServerConfig } from "@t3tools/contracts";
import { DesktopAppSettings, layerTest } from "../../settings/DesktopAppSettings.ts";
import {
  LocalMcpManager,
  createLocalMcpManager,
  layer as localMcpLayer,
} from "../../remoteControl/LocalMcpManager.ts";
import { WinExecService } from "../../remoteControl/WinExecService.ts";
import { ElectronWindow } from "../../electron/ElectronWindow.ts";
import { getCapabilities } from "./remoteControl.ts";
import * as Methods from "./localMcp.ts";
import * as Channels from "../channels.ts";

vi.mock("electron", () => ({ webContents: { fromId: () => undefined } }));
vi.mock("node:os", { spy: true });
const config: LocalMcpServerConfig = {
  id: "unity",
  name: "Unity",
  enabled: false,
  transport: { type: "stdio", command: "t3-missing-mcp-fixture", args: [], env: {} },
};

it.effect(
  "discovers through validated IPC using local paths without saving or publishing capabilities",
  () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-mcp-discovery-")),
      );
      const save = vi.fn(async () => {});
      const manager = createLocalMcpManager({ save });
      const onChanged = vi.fn();
      manager.onChanged(onChanged);
      try {
        vi.spyOn(NodeOS, "homedir").mockReturnValue(directory);
        vi.stubEnv("APPDATA", directory);
        const url = "http://127.0.0.1:8080/mcp";
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(
            NodePath.join(directory, ".claude.json"),
            `{"mcpServers":{"unityMCP":{"type":"http","url":"${url}"}}}`,
          );
          await manager.initialize([{ ...config, transport: { type: "http", url, headers: {} } }]);
        });
        save.mockClear();
        onChanged.mockClear();
        const capabilities = manager.capabilities();
        const result = yield* Methods.discover
          .handler(undefined)
          .pipe(Effect.provideService(LocalMcpManager, manager));
        expect(result).toMatchObject({
          servers: [
            {
              config: { id: "unity-2", enabled: true },
              addedAs: "unity",
              sources: [{ app: "claude-code" }],
            },
          ],
          skipped: [],
          scannedAt: expect.any(String),
        });
        expect(save).not.toHaveBeenCalled();
        expect(onChanged).not.toHaveBeenCalled();
        expect(manager.capabilities()).toEqual(capabilities);
      } finally {
        yield* Effect.promise(async () => {
          vi.restoreAllMocks();
          vi.unstubAllEnvs();
          await manager.dispose();
          await NodeFSP.rm(directory, { recursive: true, force: true });
        });
      }
    }),
);

it.effect("local MCP IPC validates, persists, lists, toggles, restarts, probes, and removes", () =>
  Effect.gen(function* () {
    const settings = yield* DesktopAppSettings;
    const manager = yield* LocalMcpManager;
    yield* Effect.gen(function* () {
      expect(yield* Methods.list.handler(undefined)).toEqual([]);
      expect(yield* Methods.upsert.handler(config)).toMatchObject([
        { config, status: "stopped", tools: [] },
      ]);
      expect((yield* settings.get).remoteControl.localMcpServers).toEqual([config]);
      const invalid = yield* Methods.upsert
        .handler({ ...config, id: "invalid__id" })
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      expect(manager.views()).toHaveLength(1);
      yield* Methods.restart.handler({ id: "unity" });
      expect(manager.views()[0]?.status).toBe("stopped");
      yield* Methods.setEnabled.handler({ id: "unity", enabled: true });
      expect((yield* settings.get).remoteControl.localMcpServers[0]?.enabled).toBe(true);
      yield* Methods.setEnabled.handler({ id: "unity", enabled: false });
      expect(manager.capabilities().servers).toEqual([]);
      expect(yield* Methods.probe.handler(config)).toMatchObject({
        ok: false,
        error: expect.stringContaining("ENOENT"),
      });
      yield* Methods.remove.handler({ id: "unity" });
      expect(yield* Methods.list.handler(undefined)).toEqual([]);
      expect((yield* settings.get).remoteControl.localMcpServers).toEqual([]);
    }).pipe(Effect.provideService(LocalMcpManager, manager));
  }).pipe(Effect.provide(localMcpLayer.pipe(Layer.provideMerge(layerTest()))), Effect.scoped),
);

it.effect("merges exec and MCP capabilities and forwards changed snapshots to renderers", () =>
  Effect.gen(function* () {
    const manager = createLocalMcpManager({ save: async () => {} });
    yield* Effect.addFinalizer(() => Effect.promise(() => manager.dispose()));
    const messages: Array<{ channel: string; payload: unknown }> = [];
    let delivered!: () => void;
    const receipt = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const windows = ElectronWindow.of({
      create: () => Effect.die("unexpected create"),
      main: Effect.succeedNone,
      currentMainOrFirst: Effect.succeedNone,
      focusedMainOrFirst: Effect.succeedNone,
      setMain: () => Effect.void,
      clearMain: () => Effect.void,
      prepareReveal: () => Effect.succeed(false),
      reveal: () => Effect.void,
      sendAll: (channel, payload) =>
        Effect.sync(() => {
          messages.push({ channel, payload });
          if (channel === Channels.REMOTE_CONTROL_CAPABILITIES_CHANGED_CHANNEL) delivered();
        }),
      destroyAll: Effect.void,
      syncAllAppearance: () => Effect.void,
    });
    yield* Effect.gen(function* () {
      yield* Methods.installEventForwarding();
      yield* Effect.promise(() => manager.upsert(config));
      yield* Effect.promise(() => receipt);
      expect(
        messages.find((item) => item.channel === Channels.LOCAL_MCP_CHANGED_CHANNEL)?.payload,
      ).toMatchObject([{ config }]);
      expect(yield* getCapabilities.handler(undefined)).toEqual({
        enabled: true,
        exec: { version: "1", shells: ["pwsh"] },
        mcp: { version: "1", servers: [] },
      });
      expect(
        messages.find(
          (item) => item.channel === Channels.REMOTE_CONTROL_CAPABILITIES_CHANGED_CHANNEL,
        )?.payload,
      ).toEqual({
        enabled: true,
        exec: { version: "1", shells: ["pwsh"] },
        mcp: { version: "1", servers: [] },
      });
    }).pipe(
      Effect.provideService(LocalMcpManager, manager),
      Effect.provideService(ElectronWindow, windows),
      Effect.provideService(WinExecService, {
        handlers: {},
        disconnectAll: async () => {},
        getCapabilities: async () => ({ enabled: true, exec: { version: "1", shells: ["pwsh"] } }),
      }),
    );
  }).pipe(Effect.scoped),
);
