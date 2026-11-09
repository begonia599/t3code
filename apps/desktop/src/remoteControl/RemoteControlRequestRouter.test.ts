import { describe, expect, it, vi } from "vite-plus/test";
import {
  createRemoteControlRequestRouter,
  type RequestOwner,
} from "./RemoteControlRequestRouter.ts";

const identity = {
  hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
  hostName: "test",
  platform: "win32" as const,
  appVersion: "1",
};
const input = (kind = "ping", requestId = "r") => ({
  environmentId: "env",
  connectionId: "conn",
  request: { requestId, kind, input: {}, context: {}, timeoutMs: 1000 },
});
const owner: RequestOwner = { id: 1, onGone: () => () => {} };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("remote control request router", () => {
  it("answers ping and rejects unsupported kinds", async () => {
    const router = createRemoteControlRequestRouter({
      identity: async () => identity,
      now: () => 42,
    });
    router.start(input(), owner);
    expect(await router.next("r", 1)).toEqual({
      type: "result",
      ok: true,
      result: { ...identity, now: 42 },
    });
    router.start(input("future"), owner);
    expect(await router.next("r", 1)).toMatchObject({
      type: "result",
      ok: false,
      error: { code: "UNSUPPORTED_KIND" },
    });
  });
  it("applies backpressure and delivers all events before the result", async () => {
    const full = deferred<void>();
    const resumed = vi.fn();
    const router = createRemoteControlRequestRouter({
      identity: async () => identity,
      now: () => 0,
      capacity: 1,
      handlers: {
        stream: async ({ emit }) => {
          await emit({ kind: "stdout", data: "a" });
          full.resolve();
          await emit({ kind: "stderr", data: "b" });
          resumed();
          return "done";
        },
      },
    });
    router.start(input("stream"), owner);
    await full.promise;
    expect(resumed).not.toHaveBeenCalled();
    expect(await router.next("r", 1)).toEqual({
      type: "events",
      events: [{ kind: "stdout", data: "a" }],
    });
    expect(await router.next("r", 1)).toEqual({
      type: "events",
      events: [{ kind: "stderr", data: "b" }],
    });
    expect(await router.next("r", 1)).toEqual({ type: "result", ok: true, result: "done" });
    expect(resumed).toHaveBeenCalledOnce();
  });
  it("cancels a blocked emitter and returns CANCELLED", async () => {
    const full = deferred<void>();
    const aborted = deferred<void>();
    const router = createRemoteControlRequestRouter({
      identity: async () => identity,
      now: () => 0,
      capacity: 1,
      handlers: {
        stream: async ({ signal, emit }) => {
          signal.addEventListener("abort", () => aborted.resolve());
          await emit({ kind: "stdout", data: "a" });
          full.resolve();
          await emit({ kind: "stdout", data: "b" });
        },
      },
    });
    router.start(input("stream"), owner);
    await full.promise;
    router.cancel("r", 2);
    const result = router.next("r", 2);
    await expect(result).rejects.toThrow("Unknown");
    router.cancel("r", 1);
    await aborted.promise;
    expect(await router.next("r", 1)).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
  });
  it("aborts all requests when the owner is destroyed or navigates", async () => {
    let gone = () => {};
    const cleanup = vi.fn();
    const signals: AbortSignal[] = [];
    const router = createRemoteControlRequestRouter({
      identity: async () => identity,
      now: () => 0,
      handlers: {
        wait: async ({ signal }) => {
          signals.push(signal);
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
        },
      },
    });
    const watched = {
      id: 1,
      onGone: (callback: () => void) => {
        gone = callback;
        return cleanup;
      },
    };
    router.start(input("wait", "a"), watched);
    router.start(input("wait", "b"), watched);
    gone();
    expect(signals.map((s) => s.aborted)).toEqual([true, true]);
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(router.next("a", 1)).rejects.toThrow("Unknown");
  });
});
