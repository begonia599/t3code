// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- Isolated integration fixture owns its listener and agent processes.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeStringDecoder from "node:string_decoder";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Schema from "effect/Schema";
import {
  DesktopSyncClientMessage,
  DesktopSyncServerMessage,
  MUTAGEN_VERSION,
  DESKTOP_SYNC_TUNNEL_PATH,
  DESKTOP_SYNC_MAX_FRAME_BYTES,
  DESKTOP_SYNC_MAX_CONCURRENT_PER_ENVIRONMENT,
  DESKTOP_SYNC_STDERR_LIMIT_BYTES,
  DESKTOP_SYNC_OPEN_TIMEOUT_MS,
  DESKTOP_SYNC_HEARTBEAT_INTERVAL_MS,
  DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS,
  DESKTOP_SYNC_TERMINATE_GRACE_MS,
} from "@t3tools/contracts";
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopSyncClientMessage), {
  onExcessProperty: "error",
});
const encode = Schema.encodeSync(Schema.fromJsonString(DesktopSyncServerMessage));

// desktop's composite TS project cannot import server implementation files
// (TS6307). This fixture implements the contracts and only runs the preinstalled
// real agent. SERVER_URL mode exercises the deployed production route instead.
export async function startE2eServer(directory: string, agentPath: string) {
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const server = NodeHttp.createServer((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const wss = new NodeWS.WebSocketServer({
    noServer: true,
    maxPayload: DESKTOP_SYNC_MAX_FRAME_BYTES,
    perMessageDeflate: false,
  });
  const stops = new Set<() => Promise<void>>();
  wss.on("connection", (ws) => {
    let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
    let closed: Promise<void> = Promise.resolve();
    let exited = false;
    let eof = false;
    let lastActivity = Date.now();
    let stopping: Promise<void> | undefined;
    const send = (message: typeof DesktopSyncServerMessage.Type) => {
      if (ws.readyState === NodeWS.WebSocket.OPEN) ws.send(encode(message));
    };
    const fail = (
      code:
        | "PROTOCOL_ERROR"
        | "COMMAND_REJECTED"
        | "VERSION_MISMATCH"
        | "TOO_MANY_TUNNELS"
        | "OPEN_TIMEOUT"
        | "SPAWN_FAILED",
      message: string,
    ) => {
      send({ type: "error", code, message });
      ws.close();
    };
    const openTimer = setTimeout(
      () => fail("OPEN_TIMEOUT", "Missing open"),
      DESKTOP_SYNC_OPEN_TIMEOUT_MS,
    );
    const heartbeat = setInterval(() => {
      if (Date.now() - lastActivity >= DESKTOP_SYNC_HEARTBEAT_TIMEOUT_MS) ws.terminate();
      else if (ws.readyState === NodeWS.WebSocket.OPEN) ws.ping();
    }, DESKTOP_SYNC_HEARTBEAT_INTERVAL_MS);
    const stop = () =>
      (stopping ??= (async () => {
        clearTimeout(openTimer);
        clearInterval(heartbeat);
        if (child && !exited) {
          const owned = child;
          owned.stdin?.end();
          owned.kill("SIGTERM");
          const timer = setTimeout(() => owned.kill("SIGKILL"), DESKTOP_SYNC_TERMINATE_GRACE_MS);
          await closed;
          clearTimeout(timer);
        }
        stops.delete(stop);
      })());
    stops.add(stop);
    ws.on("close", () => {
      void stop();
    });
    ws.on("error", () => {
      ws.terminate();
      void stop();
    });
    ws.on("pong", () => {
      lastActivity = Date.now();
    });
    if (stops.size > DESKTOP_SYNC_MAX_CONCURRENT_PER_ENVIRONMENT) {
      fail("TOO_MANY_TUNNELS", "Too many synchronization tunnels");
      return;
    }
    ws.on("message", (data, binary) => {
      lastActivity = Date.now();
      const bytes = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data);
      try {
        if (binary) {
          if (!child || eof) throw new Error("Input without open or after EOF");
          if (!child.stdin!.write(bytes)) ws.pause();
          return;
        }
        const message = decode(bytes.toString("utf8"));
        if (message.type === "stdin-eof") {
          if (!child || eof) throw new Error("Invalid EOF");
          eof = true;
          child.stdin!.end();
          return;
        }
        if (child) throw new Error("Duplicate open");
        const match =
          /^\.mutagen\/agents\/(\d+\.\d+\.\d+)\/mutagen-agent synchronizer(?: (--log-level=(?:disabled|error|warn|info|debug|trace)))?$/.exec(
            message.command,
          );
        if (!match || match[0] !== message.command) {
          fail("COMMAND_REJECTED", "Only the preinstalled synchronizer is allowed");
          return;
        }
        if (match[1] !== MUTAGEN_VERSION) {
          fail("VERSION_MISMATCH", "Mutagen versions must match");
          return;
        }
        clearTimeout(openTimer);
        const agent = NodeChildProcess.spawn(
          agentPath,
          ["synchronizer", ...(match[2] ? [match[2]] : [])],
          {
            cwd: directory,
            env: { HOME: directory, ...(process.env.PATH ? { PATH: process.env.PATH } : {}) },
            stdio: "pipe",
          },
        );
        child = agent;
        closed = new Promise<void>((resolve) =>
          agent.once("close", () => {
            exited = true;
            resolve();
          }),
        );
        agent.once("error", () => fail("SPAWN_FAILED", "Cannot spawn preinstalled agent"));
        agent.stdin.on("error", () => ws.terminate());
        agent.stdin.on("drain", () => ws.resume());
        agent.stdout.on("data", (chunk: Buffer) => {
          agent.stdout.pause();
          if (ws.readyState !== NodeWS.WebSocket.OPEN) return;
          // Node pipe reads are at most 64 KiB; splitting also covers alternative stream implementations.
          for (let offset = 0; offset < chunk.length; offset += DESKTOP_SYNC_MAX_FRAME_BYTES) {
            const part = chunk.subarray(offset, offset + DESKTOP_SYNC_MAX_FRAME_BYTES);
            ws.send(part, (error) => {
              if (error) ws.terminate();
              else if (offset + DESKTOP_SYNC_MAX_FRAME_BYTES >= chunk.length) agent.stdout.resume();
            });
          }
        });
        const decoder = new NodeStringDecoder.StringDecoder("utf8");
        let stderrBytes = 0;
        agent.stderr.on("data", (chunk: Buffer) => {
          const take = chunk.subarray(
            0,
            Math.max(0, DESKTOP_SYNC_STDERR_LIMIT_BYTES - stderrBytes),
          );
          stderrBytes += take.length;
          const data = decoder.write(take);
          if (data) send({ type: "stderr", data });
        });
        agent.stderr.on("end", () => {
          const data = decoder.end();
          if (data) send({ type: "stderr", data });
        });
        agent.once("close", (code, signal) => {
          send({ type: "exit", code, signal });
          ws.close(1000);
        });
      } catch {
        fail("PROTOCOL_ERROR", "Invalid synchronization frame");
      }
    });
  });
  server.on("upgrade", (request, socket, head) => {
    if (
      request.url !== DESKTOP_SYNC_TUNNEL_PATH ||
      request.headers.authorization !== `Bearer ${token}`
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  });
  let shutdown: Promise<void> | undefined;
  const stop = () =>
    (shutdown ??= (async () => {
      for (const client of wss.clients) client.terminate();
      await Promise.all([...stops].map((stop) => stop()));
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    })());
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No e2e HTTP address");
    return { url: `http://127.0.0.1:${address.port}`, token, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
