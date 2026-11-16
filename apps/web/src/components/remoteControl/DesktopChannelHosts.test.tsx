import { expect, it } from "@effect/vitest";
import { RegistryContext } from "@effect/atom-react";
import type {
  DesktopChannelCapabilities,
  RemoteControlBridge,
  LocalMcpBridge,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { vi } from "vite-plus/test";

const io = vi.hoisted(() => ({ run: vi.fn(), connected: vi.fn() }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [{ environmentId: "env-a" }, { environmentId: "env-b" }],
  }),
}));
vi.mock("~/state/windowsProjects", () => ({ setWindowsProjectHostConnected: io.connected }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: (...args: unknown[]) => io.run(...args),
  squashAtomCommandFailure: () => new Error("failed"),
}));
vi.mock("@t3tools/client-runtime/connection", async (importOriginal) => {
  const { Atom } = await import("effect/unstable/reactivity");
  const Stream = await import("effect/Stream");
  const { runDesktopChannelHost } =
    await importOriginal<
      Pick<typeof import("@t3tools/client-runtime/connection"), "runDesktopChannelHost">
    >();
  return {
    createDesktopChannelEnvironmentAtoms: () => ({
      host: (options: Parameters<typeof runDesktopChannelHost>[1]) =>
        Atom.make(
          runDesktopChannelHost(
            Stream.make({
              type: "connected" as const,
              connectionId: `connection-${options.host.environmentId}`,
            }).pipe(Stream.concat(Stream.never)),
            options,
          ),
        ),
      emit: "emit",
      respond: "respond",
      updateCapabilities: "updateCapabilities",
    }),
  };
});
import { DesktopChannelHosts } from "./DesktopChannelHosts";

it("hosts every enabled environment and forwards live capabilities through the environment command", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const registry = AtomRegistry.make();
  let renderer: ReactTestRenderer | undefined;
  const capabilities: DesktopChannelCapabilities = {
    enabled: true,
    mcp: { version: "1", servers: [] },
  };
  const listeners = new Set<(value: DesktopChannelCapabilities) => void>();
  let enabledListener: (ids: readonly string[]) => void = () => {};
  const remoteControl: RemoteControlBridge = {
    getHostIdentity: async () => ({
      hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
      hostName: "test",
      platform: "win32",
      appVersion: "1",
    }),
    getEnabledEnvironmentIds: async () => ["env-a", "env-b"],
    getCapabilities: async () => capabilities,
    onCapabilitiesChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onEnabledEnvironmentIdsChanged: (listener) => {
      enabledListener = listener;
      return () => {};
    },
    setEnvironmentEnabled: async () => {},
    start: async () => {},
    next: async () => ({ type: "result", ok: true, result: {} }),
    cancel: async () => {},
    getConfig: async () => ({
      hostId: "test",
      hostName: "test",
      enabledEnvironmentIds: [],
      allowlist: [],
      mappings: [],
      strictMode: false,
    }),
    updateConfig: async () => ({
      hostId: "test",
      hostName: "test",
      enabledEnvironmentIds: [],
      allowlist: [],
      mappings: [],
      strictMode: false,
    }),
    listGrants: async () => [],
    revokeGrant: async () => {},
    getPendingGrantRequests: async () => [],
    resolveGrant: async () => {},
    readAudit: async () => [],
    disconnectAll: async () => {},
    onConfigChanged: () => () => {},
    onGrantsChanged: () => () => {},
    onPendingGrantRequestsChanged: () => () => {},
  };
  const localMcp: LocalMcpBridge = {
    list: async () => [],
    upsert: async () => [],
    remove: async () => [],
    setEnabled: async () => [],
    restart: async () => [],
    probe: async () => ({ ok: false, error: "unused" }),
    discover: async () => ({ servers: [], skipped: [], scannedAt: "2026-11-16T00:00:00Z" }),
    onChanged: () => () => {},
  };
  vi.stubGlobal("window", { desktopBridge: { remoteControl, localMcp } });
  let expected = 2;
  let delivered!: () => void;
  let receipt = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  io.run.mockReset().mockImplementation(async () => {
    if (io.run.mock.calls.length === expected) delivered();
    return { _tag: "Success", value: undefined };
  });
  try {
    await act(async () => {
      renderer = create(
        <RegistryContext.Provider value={registry}>
          <DesktopChannelHosts />
        </RegistryContext.Provider>,
      );
    });
    await receipt;
    expect(listeners.size).toBe(2);
    expected = 4;
    receipt = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const changed: DesktopChannelCapabilities = {
      enabled: true,
      mcp: {
        version: "1",
        servers: [
          {
            id: "unity",
            name: "Unity",
            status: "running",
            tools: [{ name: "echo", inputSchema: { type: "object" } }],
          },
        ],
      },
    };
    for (const listener of listeners) listener(changed);
    await receipt;
    expect(io.run.mock.calls.slice(2).map(([, command, value]) => ({ command, value }))).toEqual([
      {
        command: "updateCapabilities",
        value: {
          environmentId: "env-a",
          input: {
            hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
            connectionId: "connection-env-a",
            capabilities: changed,
          },
        },
      },
      {
        command: "updateCapabilities",
        value: {
          environmentId: "env-b",
          input: {
            hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
            connectionId: "connection-env-b",
            capabilities: changed,
          },
        },
      },
    ]);
    await act(async () => {
      enabledListener([]);
    });
  } finally {
    await act(() => renderer?.unmount());
    registry.dispose();
    vi.unstubAllGlobals();
  }
  expect(listeners.size).toBe(0);
});
