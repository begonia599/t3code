// @effect-diagnostics nodeBuiltinImport:off - drives the real route over Node HTTP and ws in-memory sockets.
import * as NodeFSP from "node:fs/promises";
import * as NodeStream from "node:stream";
import type * as NodeNet from "node:net";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import {
  DESKTOP_SYNC_MAX_FRAME_BYTES,
  DESKTOP_SYNC_TUNNEL_PATH,
  DESKTOP_SYNC_STDERR_LIMIT_BYTES,
  DESKTOP_SYNC_SEND_HIGH_WATER_BYTES,
  DesktopSyncClientMessage,
  DesktopSyncServerMessage,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { routes } from "./routes.ts";

const encodeClient = Schema.encodeSync(Schema.fromJsonString(DesktopSyncClientMessage));
const decodeServer = Schema.decodeUnknownSync(Schema.fromJsonString(DesktopSyncServerMessage));
const command = ".mutagen/agents/0.18.1/mutagen-agent synchronizer --log-level=info";
const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
  vi.unstubAllEnvs();
});

function mailbox<A>() {
  const values: A[] = [];
  const readers: ((value: A) => void)[] = [];
  return {
    push(value: A) {
      const reader = readers.shift();
      if (reader) reader(value);
      else values.push(value);
    },
    next: () =>
      new Promise<A>((resolve) => {
        const value = values.shift();
        if (value !== undefined) resolve(value);
        else readers.push(resolve);
      }),
  };
}
const logFields = Schema.Struct({
  session: Schema.String,
  durationMs: Schema.Number,
  upstreamBytes: Schema.Number,
  downstreamBytes: Schema.Number,
  exitCode: Schema.NullOr(Schema.Number),
  reason: Schema.String,
});
const decodeLog = Schema.decodeUnknownSync(logFields);
// Raw fd I/O also works in sandboxes where Node cannot wrap inherited socketpair fds as
// net.Socket streams. This mirrors the agent's binary stdio and blocks naturally on backpressure.
const scriptPrelude = `
const fs = require('node:fs');
function write(fd, value) {
  const bytes = Buffer.from(value);
  for (let offset = 0; offset < bytes.length;) offset += fs.writeSync(fd, bytes, offset);
}
`;
const echoScript = `
write(2, 'pid:' + process.pid + '\\n');
const input = Buffer.alloc(65536);
for (;;) {
  const count = fs.readSync(0, input);
  if (count === 0) break;
  write(1, input.subarray(0, count));
}
write(1, 'EOF');
process.exitCode = 7;
`;

async function fixture(script = echoScript) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-sync-"));
  disposers.push(() => NodeFSP.rm(directory, { recursive: true, force: true }));
  vi.stubEnv("HOME", directory);
  const agentPath = NodePath.join(directory, "fake-mutagen-agent");
  await NodeFSP.writeFile(agentPath, `#!${process.execPath}\n${scriptPrelude}\n${script}`, {
    mode: 0o700,
  });
  vi.stubEnv("T3CODE_MUTAGEN_AGENT_PATH", agentPath);
  const server = NodeHttp.createServer();
  const connections: { client: NodeStream.Duplex; server: NodeStream.Duplex }[] = [];
  let webSocketServer: NodeWS.WebSocketServer;
  const closedLogs = mailbox<typeof logFields.Type>();
  const openedLogs = mailbox<typeof logFields.Type>();
  const logger = Logger.make(({ message }) => {
    const parts: ReadonlyArray<unknown> = Array.isArray(message) ? message : [message];
    if (parts[0] === "desktop sync tunnel closed") closedLogs.push(decodeLog(parts[1]));
    if (parts[0] === "desktop sync tunnel opened") openedLogs.push(decodeLog(parts[1]));
  });
  const authLayer = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provide(ServerConfig.layerTest(directory, { prefix: "sync-auth-" })),
  );
  const app = Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(
          routes,
          HttpRouter.add("GET", "*", Effect.succeed(HttpServerResponse.text("SPA fallback"))),
        ),
      );
      const wss = yield* Effect.acquireRelease(
        Effect.sync(() => new NodeWS.WebSocketServer({ noServer: true, perMessageDeflate: true })),
        (wss) =>
          Effect.sync(() => {
            for (const client of wss.clients) client.terminate();
            wss.close();
          }),
      );
      webSocketServer = wss;
      server.on("request", yield* NodeHttpServer.makeHandler(httpEffect, { scope }));
      server.on(
        "upgrade",
        yield* NodeHttpServer.makeUpgradeHandler(Effect.succeed(wss), httpEffect, { scope }),
      );
    }),
  ).pipe(
    Layer.provideMerge(authLayer),
    Layer.provide(NodeServices.layer),
    Layer.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
  // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- Own a real HTTP server and auth service across native WebSocket events, including explicit shutdown assertions.
  const runtime = ManagedRuntime.make(app);
  let disposed = false;
  const shutdown = async () => {
    if (!disposed) {
      disposed = true;
      await runtime.dispose();
    }
  };
  disposers.push(shutdown);
  const auth = await runtime.runPromise(EnvironmentAuth.EnvironmentAuth);
  const token = await runtime.runPromise(auth.issueSession());
  const url = `ws://localhost${DESKTOP_SYNC_TUNNEL_PATH}`;
  // Exercise Node's actual HTTP parser, upgrade head, ws framing/compression and backpressure
  // without binding an OS socket (the coding sandbox forbids even loopback listeners).
  const createConnection = () => {
    const [clientSide, serverSide] = NodeStream.duplexPair();
    clientSide.once("close", () => serverSide.destroy());
    serverSide.once("close", () => clientSide.destroy());
    connections.push({ client: clientSide, server: serverSide });
    server.emit("connection", serverSide);
    return clientSide as NodeNet.Socket;
  };
  const clients = new Set<NodeWS.WebSocket>();
  disposers.push(async () => {
    for (const client of clients) client.terminate();
  });

  async function connect(options: { token?: string; autoPong?: boolean; ticket?: string } = {}) {
    const ws = new NodeWS.WebSocket(url + (options.ticket ? `?wsTicket=${options.ticket}` : ""), {
      headers: { authorization: `Bearer ${options.token ?? token.token}` },
      autoPong: options.autoPong ?? true,
      createConnection,
    });
    clients.add(ws);
    const inbox = mailbox<Buffer | DesktopSyncServerMessage>();
    const events: (Buffer | DesktopSyncServerMessage | { type: "close"; code: number })[] = [];
    ws.on("message", (data, binary) => {
      const value = binary ? Buffer.from(data as Buffer) : decodeServer(data.toString());
      events.push(value);
      inbox.push(value);
    });
    const closed = new Promise<number>((resolve) =>
      ws.once("close", (code) => {
        events.push({ type: "close", code });
        resolve(code);
      }),
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return {
      ws,
      events,
      closed,
      next: () =>
        Promise.race([
          inbox.next(),
          closed.then((code) => {
            throw new Error(`WebSocket closed before next message (${code})`);
          }),
        ]),
      send: (message: DesktopSyncClientMessage) => ws.send(encodeClient(message)),
      open: () => ws.send(encodeClient({ type: "open", command })),
    };
  }
  return {
    connect,
    closedLogs,
    openedLogs,
    url,
    agentPath,
    auth,
    runtime,
    shutdown,
    createConnection,
    connections,
    serverSockets: () => [...webSocketServer.clients],
  };
}

async function getPid(client: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["connect"]>>) {
  const message = await client.next();
  expect(message).toMatchObject({ type: "stderr" });
  if (Buffer.isBuffer(message) || message.type !== "stderr") throw new Error("No PID receipt");
  return Number(message.data.trim().slice(4));
}
function expectGone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

describe("desktop synchronization endpoint", () => {
  it("rejects unauthenticated upgrades before the SPA route or agent startup", async () => {
    const f = await fixture();
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new NodeWS.WebSocket(f.url, { createConnection: f.createConnection });
      ws.once("unexpected-response", (request, response) => {
        resolve(response.statusCode ?? 0);
        response.resume();
        request.destroy();
      });
      ws.on("error", reject);
    });
    expect(status).toBe(401);
  });

  it.each([
    Buffer.from("binary"),
    encodeClient({ type: "stdin-eof" }),
    "{invalid",
    '{"type":"open","command":"x","extra":1}',
  ])("requires open as the first message (%s)", async (first) => {
    const f = await fixture();
    const client = await f.connect();
    client.ws.send(first);
    expect(await client.next()).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    expect(await client.closed).toBe(1008);
  });

  it("closes an idle connection after the open deadline", async () => {
    const f = await fixture();
    const client = await f.connect();
    expect(await client.next()).toMatchObject({ type: "error", code: "OPEN_TIMEOUT" });
    expect(await client.closed).toBe(1008);
  });

  it("round-trips binary streams larger than one frame, forwards EOF/stderr, then exit before close", async () => {
    const f = await fixture();
    const client = await f.connect();
    client.open();
    const pid = await getPid(client);
    const data = Buffer.alloc(DESKTOP_SYNC_MAX_FRAME_BYTES * 5 + 19);
    for (let i = 0; i < data.length; i++) data[i] = i % 256;
    for (let i = 0; i < data.length; i += DESKTOP_SYNC_MAX_FRAME_BYTES)
      client.ws.send(data.subarray(i, i + DESKTOP_SYNC_MAX_FRAME_BYTES));
    client.send({ type: "stdin-eof" });
    expect(await client.closed).toBe(1000);
    const chunks = client.events.filter(Buffer.isBuffer);
    expect(chunks.every((chunk) => chunk.length <= DESKTOP_SYNC_MAX_FRAME_BYTES)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([data, Buffer.from("EOF")]));
    expect(client.events.slice(-2)).toEqual([
      { type: "exit", code: 7, signal: null },
      { type: "close", code: 1000 },
    ]);
    const log = await f.closedLogs.next();
    expect(log).toMatchObject({
      upstreamBytes: data.length,
      downstreamBytes: data.length + 3,
      exitCode: 7,
      reason: "agent-exit",
    });
    expectGone(pid);
  });

  it("splits a large agent write and caps stderr while still draining it", async () => {
    const f = await fixture(
      `write(2, Buffer.alloc(200000, 120)); write(1, Buffer.alloc(400000, 255));`,
    );
    const client = await f.connect();
    client.open();
    expect(await client.closed).toBe(1000);
    const binary = client.events.filter(Buffer.isBuffer);
    expect(Buffer.concat(binary).equals(Buffer.alloc(400000, 255))).toBe(true);
    expect(binary.every((chunk) => chunk.length <= DESKTOP_SYNC_MAX_FRAME_BYTES)).toBe(true);
    const stderr = client.events.filter(
      (value): value is { readonly type: "stderr"; readonly data: string } =>
        !Buffer.isBuffer(value) && value.type === "stderr",
    );
    expect(stderr.reduce((total, value) => total + Buffer.byteLength(value.data), 0)).toBe(
      DESKTOP_SYNC_STDERR_LIMIT_BYTES,
    );
    expect(client.events.at(-2)).toEqual({ type: "exit", code: 0, signal: null });
  });

  it("reaps the agent after client disconnect", async () => {
    const f = await fixture();
    const client = await f.connect();
    client.open();
    const pid = await getPid(client);
    client.ws.terminate();
    await f.closedLogs.next();
    expectGone(pid);
  });

  it("reaps a disconnected agent even while its stdin is blocked", async () => {
    const f = await fixture(`write(2, 'pid:' + process.pid); setInterval(() => {}, 1000);`);
    const client = await f.connect();
    client.open();
    const pid = await getPid(client);
    const paused = new Promise<void>((resolve) =>
      f.connections[0]!.server.once("pause", () => resolve()),
    );
    for (let i = 0; i < 8; i++) client.ws.send(Buffer.alloc(DESKTOP_SYNC_MAX_FRAME_BYTES));
    await paused;
    client.ws.terminate();
    await f.closedLogs.next();
    expectGone(pid);
  });

  it("enforces an environment-wide limit across sessions and returns the slot after cleanup", async () => {
    const f = await fixture();
    const clients = [];
    for (let i = 0; i < 8; i++) {
      const client = await f.connect();
      client.open();
      await getPid(client);
      clients.push(client);
    }
    const secondToken = await f.runtime.runPromise(f.auth.issueSession());
    const rejected = await f.connect({ token: secondToken.token });
    expect(await rejected.next()).toMatchObject({ type: "error", code: "TOO_MANY_TUNNELS" });
    await rejected.closed;
    await f.closedLogs.next();
    clients[0]!.ws.terminate();
    await f.closedLogs.next();
    const replacement = await f.connect({ token: secondToken.token });
    replacement.open();
    await getPid(replacement);
  });

  it.each([
    [command.replace("0.18.1", "0.18.0"), "VERSION_MISMATCH"],
    [command + "; id", "COMMAND_REJECTED"],
  ])("returns a typed command error for %s", async (value, code) => {
    const f = await fixture();
    const client = await f.connect();
    client.send({ type: "open", command: value });
    expect(await client.next()).toMatchObject({ type: "error", code });
    await client.closed;
  });

  it.each(["missing", "not-executable", "spawn-failure"])("reports %s agent", async (mode) => {
    const f = await fixture();
    if (mode === "missing") await NodeFSP.unlink(f.agentPath);
    if (mode === "not-executable") await NodeFSP.chmod(f.agentPath, 0o600);
    if (mode === "spawn-failure") await NodeFSP.writeFile(f.agentPath, "#!/no/such/interpreter\n");
    const client = await f.connect();
    client.open();
    expect(await client.next()).toMatchObject({
      type: "error",
      code: mode === "spawn-failure" ? "SPAWN_FAILED" : "AGENT_MISSING",
    });
    await client.closed;
  });

  it("passes only the permitted environment, argv and HOME working directory", async () => {
    vi.stubEnv("T3_SYNC_TEST_SECRET", "must-not-leak");
    const f = await fixture(`
      const expected = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'USER', 'TMPDIR'];
      const clean = Object.keys(process.env).every(key => expected.includes(key));
      const argv = process.argv.slice(2).join(' ') === 'synchronizer --log-level=info';
      write(1, String(clean && argv && process.cwd() === process.env.HOME));
    `);
    const client = await f.connect();
    client.open();
    await client.closed;
    expect(Buffer.concat(client.events.filter(Buffer.isBuffer)).toString()).toBe("true");
  });

  it("reaps every active agent when the server scope closes", async () => {
    const f = await fixture();
    const client = await f.connect();
    client.open();
    const pid = await getPid(client);
    await f.shutdown();
    expectGone(pid);
    await client.closed;
  });

  it("kills a SIGTERM-resistant agent after the grace period", async () => {
    const f = await fixture(
      `process.on('SIGTERM', () => {}); write(2, 'pid:' + process.pid); setInterval(() => {}, 1000);`,
    );
    const client = await f.connect();
    client.open();
    const pid = await getPid(client);
    client.ws.terminate();
    await f.closedLogs.next();
    expectGone(pid);
  });

  it("terminates the entire process group and waits for the parent to reap its child", async () => {
    const f = await fixture(`
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      process.on('SIGTERM', () => child.once('close', () => process.exit(0)));
      child.once('spawn', () => write(2, 'group:' + process.pid + ',' + child.pid));
    `);
    const client = await f.connect();
    client.open();
    const receipt = await client.next();
    if (Buffer.isBuffer(receipt) || receipt.type !== "stderr") throw new Error("No group receipt");
    const pids = receipt.data.slice(6).split(",").map(Number);
    client.ws.terminate();
    await f.closedLogs.next();
    for (const pid of pids) expectGone(pid);
  });

  it("sends ping and reaps an agent when a silent peer stops answering", async () => {
    const f = await fixture();
    const client = await f.connect({ autoPong: false });
    const ping = new Promise<void>((resolve) => client.ws.once("ping", () => resolve()));
    client.open();
    const pid = await getPid(client);
    await ping;
    const log = await f.closedLogs.next();
    expect(log.reason).toBe("heartbeat-timeout");
    expectGone(pid);
    await client.closed;
  }, 45_000);

  it("keeps output bounded for a paused client, then drains every byte before exit", async () => {
    const f = await fixture(
      `write(2, 'pid:' + process.pid); fs.readSync(0, Buffer.alloc(1)); write(1, Buffer.alloc(8 * 1024 * 1024, 42));`,
    );
    const client = await f.connect();
    client.open();
    await getPid(client);
    client.ws.pause();
    const transport = f.connections[0]!.client;
    const buffered = new Promise<void>((resolve) => transport.once("readable", () => resolve()));
    client.ws.send(Buffer.from([1]));
    await buffered;
    expect(f.serverSockets()[0]!.bufferedAmount).toBeLessThanOrEqual(
      DESKTOP_SYNC_SEND_HIGH_WATER_BYTES,
    );
    client.ws.resume();
    expect(await client.closed).toBe(1000);
    expect(
      Buffer.concat(client.events.filter(Buffer.isBuffer)).equals(
        Buffer.alloc(8 * 1024 * 1024, 42),
      ),
    ).toBe(true);
    expect(client.events.at(-2)).toEqual({ type: "exit", code: 0, signal: null });
  });

  it.each(["oversized", "second-open", "duplicate-eof", "data-after-eof"])(
    "rejects %s without leaving an agent",
    async (mode) => {
      const f = await fixture(`write(2, 'pid:' + process.pid); setInterval(() => {}, 1000);`);
      const client = await f.connect();
      client.open();
      const pid = await getPid(client);
      if (mode === "oversized") client.ws.send(Buffer.alloc(DESKTOP_SYNC_MAX_FRAME_BYTES + 1));
      else if (mode === "second-open") client.open();
      else {
        client.send({ type: "stdin-eof" });
        if (mode === "duplicate-eof") client.send({ type: "stdin-eof" });
        else client.ws.send(Buffer.from([1]));
      }
      expect(await client.next()).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
      await client.closed;
      await f.closedLogs.next();
      expectGone(pid);
    },
  );

  it("uses the versioned agent below HOME when no override is configured", async () => {
    const f = await fixture();
    const directory = NodePath.join(NodePath.dirname(f.agentPath), ".mutagen", "agents", "0.18.1");
    await NodeFSP.mkdir(directory, { recursive: true });
    await NodeFSP.copyFile(f.agentPath, NodePath.join(directory, "mutagen-agent"));
    vi.stubEnv("T3CODE_MUTAGEN_AGENT_PATH", undefined);
    const client = await f.connect();
    client.open();
    const pid = await getPid(client);
    client.ws.terminate();
    await f.closedLogs.next();
    expectGone(pid);
  });

  it.skipIf(!process.env.T3CODE_TEST_MUTAGEN_AGENT_PATH)(
    "receives real Mutagen 0.18.1 agent magic bytes",
    async () => {
      const realAgent = process.env.T3CODE_TEST_MUTAGEN_AGENT_PATH!;
      const f = await fixture();
      vi.stubEnv("T3CODE_MUTAGEN_AGENT_PATH", realAgent);
      const client = await f.connect();
      client.open();
      const data = await client.next();
      expect(Buffer.isBuffer(data)).toBe(true);
      expect(data).toEqual(Buffer.from([0x05, 0x27, 0x87]));
      client.ws.send(Buffer.from([0x87, 0x27, 0x05]));
      client.ws.terminate();
      await f.closedLogs.next();
    },
  );
});
