// @effect-diagnostics nodeBuiltinImport:off -- Real ws/HTTP framing over in-memory duplex sockets in restricted sandboxes.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";
import type * as NodeNet from "node:net";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { afterEach, expect, it, vi } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DesktopSyncClientMessage, DesktopSyncServerMessage } from "@t3tools/contracts";
import { relayConnection, tunnelUrl } from "./relay.ts";
import { encodeHeader, Frame, frame, FrameReader, MAX_PAYLOAD } from "./protocol.ts";

function mailbox<T>() {
  const values: T[] = [];
  const readers: ((value: T) => void)[] = [];
  return {
    push(value: T) {
      const reader = readers.shift();
      if (reader) reader(value);
      else values.push(value);
    },
    next: () =>
      new Promise<T>((resolve) => {
        const value = values.shift();
        if (value !== undefined) resolve(value);
        else readers.push(resolve);
      }),
  };
}
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
});
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopSyncServerMessage));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopSyncClientMessage));
function fixture(
  resolve = async () => ({ httpBaseUrl: "https://example.test", token: "bearer-secret" }),
) {
  const [shim, socket] = NodeStream.duplexPair();
  const http = NodeHttp.createServer();
  const wss = new NodeWS.WebSocketServer({ noServer: true });
  const connected = mailbox<NodeWS.WebSocket>();
  const messages = mailbox<{ binary: boolean; data: Buffer }>();
  const requests = mailbox<{ url: string | undefined; auth: string | undefined }>();
  http.on("upgrade", (request, socket, head) => {
    requests.push({ url: request.url, auth: request.headers.authorization });
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data, binary) =>
        messages.push({ binary, data: Buffer.from(data as Buffer) }),
      );
      connected.push(ws);
    });
  });
  let clientSocket: NodeWS.WebSocket;
  const connection = relayConnection(socket, {
    token: "loopback-secret",
    resolve,
    connect: (url, token) =>
      (clientSocket = new NodeWS.WebSocket(url, {
        headers: { Authorization: `Bearer ${token}` },
        createConnection: () => {
          const [client, server] = NodeStream.duplexPair();
          client.once("close", () => server.destroy());
          server.once("close", () => client.destroy());
          http.emit("connection", server);
          cleanups.push(() => {
            client.destroy();
            server.destroy();
          });
          return client as NodeNet.Socket;
        },
      })),
  });
  const frames = mailbox<{ kind: number; payload: Buffer }>();
  const reader = new FrameReader();
  shim.on("data", (chunk: Buffer) => {
    for (const part of reader.push(chunk)) frames.push(part);
  });
  cleanups.push(() => {
    connection.stop();
    shim.destroy();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    http.close();
  });
  const header = (token = "loopback-secret") =>
    shim.write(
      encodeHeader({ v: 1, host: "t3-test", token, command: "remote command unchanged" }) + "\n",
    );
  return {
    shim,
    socket,
    connection,
    frames,
    connected,
    messages,
    requests,
    header,
    client: () => clientSocket,
  };
}
it("forwards binary streams, Bearer, half-close, stderr and exit in order", async () => {
  const f = fixture();
  f.header();
  const ws = await f.connected.next();
  expect(await f.requests.next()).toEqual({
    url: "/api/desktop-sync/v1/tunnel",
    auth: "Bearer bearer-secret",
  });
  expect(decode((await f.messages.next()).data.toString())).toEqual({
    type: "open",
    command: "remote command unchanged",
  });
  const data = Buffer.from([0, 255, 13, 10, 128]);
  const bytes = frame(Frame.stdin, data);
  for (const byte of bytes) f.shim.write(Buffer.from([byte]));
  expect(await f.messages.next()).toEqual({ binary: true, data });
  f.shim.write(frame(Frame.eof));
  expect(decode((await f.messages.next()).data.toString())).toEqual({ type: "stdin-eof" });
  ws.send(data);
  ws.send(encode({ type: "stderr", data: "diagnostic" }));
  ws.send(encode({ type: "exit", code: 7, signal: null }));
  expect(await f.frames.next()).toEqual({ kind: Frame.stdout, payload: data });
  expect(await f.frames.next()).toEqual({ kind: Frame.stderr, payload: Buffer.from("diagnostic") });
  expect(await f.frames.next()).toEqual({ kind: Frame.exit, payload: Buffer.from([0, 0, 0, 7]) });
});
it("rejects unauthorized loopback connections before looking up credentials", async () => {
  const resolve = vi.fn(async () => ({ httpBaseUrl: "http://unused", token: "secret" }));
  const f = fixture(resolve);
  f.header("bad-token");
  expect((await f.frames.next()).payload.toString()).toBe("Invalid sync relay token");
  expect(resolve).not.toHaveBeenCalled();
});
it("reports unknown aliases and malformed headers without reflecting secrets", async () => {
  const f = fixture(async () => {
    throw new Error("Unknown synchronization host alias");
  });
  f.header();
  expect((await f.frames.next()).payload.toString()).toContain(
    "Unknown synchronization host alias",
  );
  const bad = fixture();
  bad.shim.write('{"token":"do-not-reflect"}\n');
  expect((await bad.frames.next()).payload.toString()).toBe("Invalid sync relay header");
});
it("closes the tunnel when a shim disappears without stdin EOF", async () => {
  const f = fixture();
  f.header();
  const ws = await f.connected.next();
  await f.messages.next();
  const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
  f.shim.end();
  await closed;
  await f.connection.done;
});
it("fails on a tunnel disconnect without exit or invalid input frame", async () => {
  const f = fixture();
  f.header();
  const ws = await f.connected.next();
  await f.messages.next();
  ws.close();
  expect((await f.frames.next()).kind).toBe(Frame.error);
  const bad = fixture();
  bad.header();
  await bad.connected.next();
  await bad.messages.next();
  bad.shim.write(frame(Frame.exit));
  expect((await bad.frames.next()).payload.toString()).toBe("Invalid shim input frame");
});
it("keeps idle tunnels alive on server pings", async () => {
  const f = fixture();
  f.header();
  const ws = await f.connected.next();
  await f.messages.next();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 25_000);
  const pong = new Promise<void>((resolve) => ws.once("pong", () => resolve()));
  ws.ping();
  await pong;
  // Native timer remains real; drive its callback with fake timers from connection setup in a separate case.
  vi.useRealTimers();
  expect(ws.readyState).toBe(NodeWS.WebSocket.OPEN);
});
it("bounds frames and preserves partial headers", () => {
  const reader = new FrameReader();
  const bytes = frame(Frame.stdout, Buffer.alloc(MAX_PAYLOAD, 255));
  expect([...reader.push(bytes.subarray(0, 3))]).toEqual([]);
  expect([...reader.push(bytes.subarray(3))][0]?.payload.length).toBe(MAX_PAYLOAD);
  expect(() => [...reader.push(Buffer.from([1, 0, 1, 0, 1]))]).toThrow("too large");
  expect(tunnelUrl("https://host/prefix/").href).toBe(
    "wss://host/prefix/api/desktop-sync/v1/tunnel",
  );
});

it("pauses WebSocket delivery until a blocked shim drains", async () => {
  const f = fixture();
  f.header();
  const ws = await f.connected.next();
  await f.messages.next();
  f.shim.pause();
  const client = f.client();
  const pause = client.pause.bind(client);
  const paused = new Promise<void>((resolve) => {
    vi.spyOn(client, "pause").mockImplementation(() => {
      pause();
      resolve();
    });
  });
  const payload = Buffer.alloc(MAX_PAYLOAD, 217);
  ws.send(payload);
  await paused;
  expect(f.socket.writableNeedDrain).toBe(true);
  const resumed = new Promise<void>((resolve) => f.socket.once("drain", resolve));
  f.shim.resume();
  expect(await f.frames.next()).toEqual({ kind: Frame.stdout, payload });
  await resumed;
  expect(client.isPaused).toBe(false);
});
it("terminates a silent WebSocket after the heartbeat deadline", async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.header();
  await f.connected.next();
  await f.messages.next();
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await f.frames.next()).payload.toString()).toContain("heartbeat timed out");
});
