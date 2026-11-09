import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  type DesktopChannelStreamEvent,
  type RemoteControlNext,
} from "@t3tools/contracts";
import {
  createDesktopChannelHostLoop,
  runDesktopChannelHost,
  type DesktopChannelHostDependencies,
} from "./desktopChannel.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const request: DesktopChannelStreamEvent = {
  type: "request",
  requestId: "r",
  kind: "ping",
  input: {},
  context: {},
  timeoutMs: 1000,
};
const setup = (next: DesktopChannelHostDependencies["bridge"]["next"]) => {
  const options: DesktopChannelHostDependencies = {
    host: {
      hostId: "91d581f4-d87a-4efe-967c-2b60314575bb",
      hostName: "test",
      platform: "win32",
      appVersion: "1",
      environmentId: EnvironmentId.make("env"),
      capabilities: { enabled: true },
    },
    bridge: { start: vi.fn(async () => {}), next, cancel: vi.fn(async () => {}) },
    rpc: { emit: vi.fn(async () => {}), respond: vi.fn(async () => {}) },
    clock: { now: () => 0 },
    onError: vi.fn(),
  };
  return { options, loop: createDesktopChannelHostLoop(options) };
};

it("sends consecutive seq values, awaits each acknowledgement, and only then responds", async () => {
  const emitted = [deferred<void>(), deferred<void>()];
  const ack = [deferred<void>(), deferred<void>()];
  const responses: RemoteControlNext[] = [
    { type: "events", events: [{ kind: "stdout", data: "a" }] },
    { type: "events", events: [{ kind: "stderr", data: "b" }] },
    { type: "result", ok: true, result: "pong" },
  ];
  const next = vi.fn(async () => responses.shift()!);
  const { options, loop } = setup(next);
  vi.mocked(options.rpc.emit).mockImplementation(async ({ seq }) => {
    emitted[seq]!.resolve();
    await ack[seq]!.promise;
  });
  await loop.receive({ type: "connected", connectionId: "c" });
  const work = loop.receive(request);
  await emitted[0]!.promise;
  expect(next).toHaveBeenCalledTimes(1);
  expect(options.rpc.respond).not.toHaveBeenCalled();
  ack[0]!.resolve();
  await emitted[1]!.promise;
  expect(options.rpc.emit).toHaveBeenCalledTimes(2);
  expect(next).toHaveBeenCalledTimes(2);
  expect(options.rpc.respond).not.toHaveBeenCalled();
  ack[1]!.resolve();
  await work;
  expect(vi.mocked(options.rpc.emit).mock.calls.map(([batch]) => batch.seq)).toEqual([0, 1]);
  expect(options.rpc.respond).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: "c", ok: true, result: "pong" }),
  );
});

it("forwards cancellation", async () => {
  const pulling = deferred<void>();
  const result = deferred<RemoteControlNext>();
  const { options, loop } = setup(async () => {
    pulling.resolve();
    return result.promise;
  });
  await loop.receive({ type: "connected", connectionId: "c" });
  const work = loop.receive(request);
  await pulling.promise;
  await loop.receive({ type: "cancel", requestId: "r" });
  expect(options.bridge.cancel).toHaveBeenCalledWith({ requestId: "r" });
  result.resolve({ type: "result", ok: false, error: { code: "CANCELLED", message: "cancelled" } });
  await work;
  expect(options.rpc.respond).toHaveBeenCalledWith(
    expect.objectContaining({ ok: false, error: { code: "CANCELLED", message: "cancelled" } }),
  );
});

it.each(["replace", "disconnect"] as const)(
  "cancels old requests on %s and never writes back",
  async (mode) => {
    const pulling = deferred<void>();
    const result = deferred<RemoteControlNext>();
    const { options, loop } = setup(async () => {
      pulling.resolve();
      return result.promise;
    });
    await loop.receive({ type: "connected", connectionId: "old" });
    const work = loop.receive(request);
    await pulling.promise;
    if (mode === "replace") await loop.receive({ type: "connected", connectionId: "new" });
    else loop.disconnect();
    result.resolve({ type: "events", events: [{ kind: "stdout", data: "late" }] });
    await work;
    expect(options.bridge.cancel).toHaveBeenCalled();
    expect(options.rpc.emit).not.toHaveBeenCalled();
    expect(options.rpc.respond).not.toHaveBeenCalled();
  },
);

it.each(["emit", "respond"] as const)("ignores STALE_CONNECTION from %s", async (method) => {
  const { options, loop } = setup(async () =>
    method === "emit"
      ? { type: "events", events: [] }
      : { type: "result", ok: true, result: "pong" },
  );
  vi.mocked(options.rpc[method]).mockImplementation(async () => {
    throw { code: "STALE_CONNECTION" };
  });
  await loop.receive({ type: "connected", connectionId: "c" });
  await loop.receive(request);
  expect(options.onError).not.toHaveBeenCalled();
});

it("cancels a start that completes after disconnect", async () => {
  const started = deferred<void>();
  const { options, loop } = setup(async () => ({
    type: "result",
    ok: false,
    error: { code: "CANCELLED", message: "cancelled" },
  }));
  vi.mocked(options.bridge.start).mockImplementation(() => started.promise);
  await loop.receive({ type: "connected", connectionId: "old" });
  const work = loop.receive(request);
  loop.disconnect();
  vi.mocked(options.bridge.cancel).mockClear();
  started.resolve();
  await work;
  expect(options.bridge.cancel).toHaveBeenCalledWith({ requestId: "r" });
  expect(options.rpc.emit).not.toHaveBeenCalled();
  expect(options.rpc.respond).not.toHaveBeenCalled();
});

const connected: DesktopChannelStreamEvent = { type: "connected", connectionId: "c" };

it("serves every event of a chunk through a mounted atom, including back-to-back requests", async () => {
  const started = [deferred<void>(), deferred<void>()];
  const { options } = setup(() => new Promise<RemoteControlNext>(() => {}));
  vi.mocked(options.bridge.start).mockImplementation(async ({ request }) => {
    started[request.requestId === "a" ? 0 : 1]!.resolve();
  });
  // The connect stream delivers these in one chunk; a stream atom value would only expose the last.
  const events = Stream.concat(
    Stream.fromIterable<DesktopChannelStreamEvent | null>([
      connected,
      { ...request, requestId: "a" },
      { ...request, requestId: "b" },
    ]),
    Stream.never,
  );
  const registry = AtomRegistry.make();
  try {
    registry.mount(Atom.make(runDesktopChannelHost(events, options)));
    await Promise.all(started.map((entry) => entry.promise));
    expect(options.bridge.start).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "c" }),
    );
  } finally {
    registry.dispose();
  }
  // Unmounting ends the host and cancels whatever was still running.
  await vi.waitFor(() => {
    expect(options.bridge.cancel).toHaveBeenCalledWith({ requestId: "a" });
    expect(options.bridge.cancel).toHaveBeenCalledWith({ requestId: "b" });
  });
});

it("cancels an in-flight request when the stream reports a lost connection", async () => {
  const pulling = deferred<void>();
  const cancelled = deferred<void>();
  const terminal = deferred<RemoteControlNext>();
  const { options } = setup(async () => {
    pulling.resolve();
    return terminal.promise;
  });
  vi.mocked(options.bridge.cancel).mockImplementation(async () => {
    cancelled.resolve();
  });
  const events = Stream.concat(
    Stream.fromIterable<DesktopChannelStreamEvent | null>([connected, request]),
    Stream.fromEffect(Effect.promise(() => pulling.promise)).pipe(Stream.map(() => null)),
  ).pipe(Stream.concat(Stream.never));
  const registry = AtomRegistry.make();
  try {
    registry.mount(Atom.make(runDesktopChannelHost(events, options)));
    await cancelled.promise;
    terminal.resolve({ type: "result", ok: true, result: "late" });
    await Promise.resolve();
    expect(options.rpc.respond).not.toHaveBeenCalled();
  } finally {
    registry.dispose();
  }
});
