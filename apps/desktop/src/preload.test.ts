import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Channels from "./ipc/channels.ts";

const listeners = vi.hoisted(() => new Map<string, () => void>());
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { on: (channel: string, listener: () => void) => listeners.set(channel, listener) },
  webFrame: {},
  webUtils: {},
}));
vi.mock("@clerk/electron/preload", () => ({ exposeClerkBridge: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it("forwards native resume IPC into the renderer connection wake event", async () => {
  const target = new EventTarget();
  const wake = vi.fn();
  target.addEventListener("t3:connection-wakeup", wake);
  vi.stubGlobal("window", target);
  await import("./preload.ts");
  listeners.get(Channels.CONNECTION_WAKEUP_CHANNEL)!();
  expect(wake).toHaveBeenCalledOnce();
});
