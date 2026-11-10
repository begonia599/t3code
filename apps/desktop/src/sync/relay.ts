// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Native duplex transport with bounded buffers and heartbeat deadlines.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Schema from "effect/Schema";
import {
  DESKTOP_SYNC_TUNNEL_PATH,
  DESKTOP_SYNC_MAX_FRAME_BYTES,
  DESKTOP_SYNC_SEND_HIGH_WATER_BYTES,
  DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS,
  DESKTOP_SYNC_HEARTBEAT_INTERVAL_MS,
  DESKTOP_SYNC_OPEN_TIMEOUT_MS,
  DesktopSyncClientMessage,
  DesktopSyncServerMessage,
} from "@t3tools/contracts";
import { decodeHeader, frame, Frame, FrameReader, MAX_HEADER, MAX_PAYLOAD } from "./protocol.ts";

export type SyncTarget = { httpBaseUrl: string; token: string };
export type ResolveSyncTarget = (host: string) => Promise<SyncTarget>;
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopSyncClientMessage));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopSyncServerMessage));
export function tunnelUrl(base: string) {
  const url = new URL(base);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("Sync requires an HTTP(S) direct environment");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/$/, "") + DESKTOP_SYNC_TUNNEL_PATH;
  url.search = "";
  url.hash = "";
  return url;
}

/** Each shim gets an independent tunnel. Closing its TCP connection also kills the remote agent. */
export function relayConnection(
  socket: NodeStream.Duplex,
  options: {
    token: string;
    resolve: ResolveSyncTarget;
    connect?: (url: URL, token: string) => NodeWS.WebSocket;
  },
) {
  let ws: NodeWS.WebSocket | undefined;
  let finished = false;
  let eof = false;
  let lastActivity = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const deadline = setTimeout(
    () => fail("Sync relay handshake timed out"),
    DESKTOP_SYNC_OPEN_TIMEOUT_MS,
  );
  const cleanup = () => {
    clearTimeout(deadline);
    if (heartbeat) clearInterval(heartbeat);
    ws?.terminate();
  };
  const fail = (message: string) => {
    if (finished) return;
    finished = true;
    // Never include credentials or remote response bodies in diagnostics.
    socket.end(frame(Frame.error, Buffer.from(message).subarray(0, MAX_PAYLOAD)));
    cleanup();
    const timer = setTimeout(() => socket.destroy(), 1000);
    timer.unref();
    socket.once("close", () => clearTimeout(timer));
  };
  socket.on("error", cleanup);
  socket.once("close", cleanup);
  socket.on("drain", () => ws?.resume());
  const send = (data: string | Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (!ws || ws.readyState !== NodeWS.WebSocket.OPEN) {
        reject(new Error("Tunnel closed"));
        return;
      }
      ws.send(data, (error) => (error ? reject(error) : resolve()));
      // The async iterator also waits for each send callback, so at most one
      // frame is outstanding even when the underlying transport is congested.
      if (ws.bufferedAmount > DESKTOP_SYNC_SEND_HIGH_WATER_BYTES) socket.pause();
    });
  const open = async (header: ReturnType<typeof decodeHeader>) => {
    const supplied = Buffer.from(header.token);
    const expected = Buffer.from(options.token);
    if (supplied.length !== expected.length || !NodeCrypto.timingSafeEqual(supplied, expected))
      throw new Error("Invalid sync relay token");
    const target = await options.resolve(header.host);
    if (socket.destroyed || finished) return;
    ws =
      options.connect?.(tunnelUrl(target.httpBaseUrl), target.token) ??
      new NodeWS.WebSocket(tunnelUrl(target.httpBaseUrl), {
        headers: { Authorization: `Bearer ${target.token}` },
        handshakeTimeout: DESKTOP_SYNC_OPEN_TIMEOUT_MS,
        // JSON escaping can expand a full stderr chunk by six times.
        maxPayload: DESKTOP_SYNC_MAX_FRAME_BYTES * 6 + 1024,
        perMessageDeflate: false,
        followRedirects: false,
      });
    ws.on("error", () => fail("Synchronization tunnel connection failed"));
    ws.on("close", () => {
      if (!finished) fail("Synchronization tunnel disconnected before exit");
    });
    ws.on("ping", () => {
      lastActivity = Date.now();
    }); // ws automatically replies with pong.
    ws.on("message", (data, binary) => {
      if (finished) return;
      lastActivity = Date.now();
      try {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data);
        let output: Buffer;
        if (binary) {
          if (bytes.length > DESKTOP_SYNC_MAX_FRAME_BYTES) throw new Error("Oversized stdout");
          output = frame(Frame.stdout, bytes);
        } else {
          const message = decode(bytes.toString("utf8"));
          if (message.type === "stderr") {
            const stderr = Buffer.from(message.data);
            for (let offset = 0; offset < stderr.length; offset += MAX_PAYLOAD) {
              if (!socket.write(frame(Frame.stderr, stderr.subarray(offset, offset + MAX_PAYLOAD))))
                ws?.pause();
              if (socket.writableLength > DESKTOP_SYNC_SEND_HIGH_WATER_BYTES)
                throw new Error("Relay output buffer exceeded");
            }
            return;
          } else if (message.type === "error") {
            fail(`${message.code}: ${message.message}`);
            return;
          } else {
            const status = Buffer.alloc(4);
            status.writeUInt32BE(
              message.code !== null && message.code >= 0 && message.code <= 255
                ? message.code
                : 255,
            );
            finished = true;
            socket.end(frame(Frame.exit, status));
            cleanup();
            return;
          }
        }
        if (!socket.write(output)) ws?.pause();
        if (socket.writableLength > DESKTOP_SYNC_SEND_HIGH_WATER_BYTES)
          throw new Error("Relay output buffer exceeded");
      } catch {
        fail("Invalid synchronization tunnel frame");
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
      ws!.once("close", () => reject(new Error("Tunnel closed before open")));
    });
    if (finished || socket.destroyed) return;
    await send(encode({ type: "open", command: header.command }));
    clearTimeout(deadline);
    lastActivity = Date.now();
    heartbeat = setInterval(() => {
      if (Date.now() - lastActivity >= DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS)
        fail("Synchronization tunnel heartbeat timed out");
    }, DESKTOP_SYNC_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref();
  };
  const done = (async () => {
    try {
      let header = Buffer.alloc(0);
      let opened = false;
      const reader = new FrameReader();
      for await (const value of socket.iterator({ destroyOnReturn: false })) {
        if (finished) break;
        let chunk = Buffer.from(value);
        if (!opened) {
          const newline = chunk.indexOf(10);
          const end = newline === -1 ? chunk.length : newline;
          if (header.length + end > MAX_HEADER) throw new Error("Sync relay header too large");
          header = Buffer.concat([header, chunk.subarray(0, end)]);
          if (newline === -1) continue;
          let decoded: ReturnType<typeof decodeHeader>;
          try {
            decoded = decodeHeader(header.toString("utf8"));
          } catch {
            throw new Error("Invalid sync relay header");
          }
          await open(decoded);
          opened = true;
          chunk = chunk.subarray(newline + 1);
        }
        for (const part of reader.push(chunk)) {
          if (finished) break;
          if (eof) throw new Error("Input after stdin-eof");
          if (part.kind === Frame.stdin) await send(part.payload);
          else if (part.kind === Frame.eof && part.payload.length === 0) {
            eof = true;
            await send(encode({ type: "stdin-eof" }));
          } else throw new Error("Invalid shim input frame");
        }
      }
      // stdin EOF is a protocol frame, not TCP EOF. TCP EOF means the shim died.
      cleanup();
    } catch (error) {
      fail(error instanceof Error ? error.message : "Sync relay failed");
    }
  })();
  return {
    done,
    stop: () => {
      finished = true;
      socket.destroy();
      cleanup();
    },
  };
}

export async function startRelay(resolve: ResolveSyncTarget) {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const connections = new Set<ReturnType<typeof relayConnection>>();
  const server = NodeNet.createServer((socket) => {
    socket.setNoDelay(true);
    const connection = relayConnection(socket, { token, resolve });
    connections.add(connection);
    socket.once("close", () => connections.delete(connection));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Invalid sync relay address");
  return {
    address: `127.0.0.1:${address.port}`,
    token,
    stop: async () => {
      const active = [...connections];
      for (const connection of active) connection.stop();
      await Promise.all(active.map((connection) => connection.done));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
