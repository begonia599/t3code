import * as NodeCrypto from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as WinMcpRelay from "./WinMcpRelay.ts";

export class WinMcpHttpOptions extends Context.Reference<{
  readonly maxSessionsPerScope: number;
  readonly idleTimeoutMs: number;
  readonly sweepIntervalMs: number;
}>("t3/desktopChannel/WinMcpHttpOptions", {
  defaultValue: () => ({
    maxSessionsPerScope: 4,
    // Clients re-initialize on a -32001 404, but an open GET stream is not "activity";
    // keep idle sessions long enough that a paused conversation does not churn them.
    idleTimeoutMs: 6 * 60 * 60_000,
    sweepIntervalMs: 30_000,
  }),
}) {}
interface Session {
  readonly id: string;
  readonly owner: string;
  readonly bearerHash: string;
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly relaySession: WinMcpRelay.WinMcpSession;
  readonly abort: AbortController;
  fingerprint: string;
  lastSeen: number;
}
const tokenHash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
// Same body the MCP SDK sends, so clients recognize an expired session and re-initialize.
const sessionNotFound = () =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
    { status: 404 },
  );

export const routes = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const relay = yield* WinMcpRelay.WinMcpRelay;
    const options = yield* WinMcpHttpOptions;
    const services = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(services);
    const sessions = new Map<string, Session>();
    const close = (session: Session) =>
      Effect.promise(async () => {
        if (!sessions.delete(session.id)) return;
        session.abort.abort();
        await session.server.close();
      });
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...sessions.values()], close, { discard: true }),
    );
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const session of sessions.values()) {
        if (
          now - session.lastSeen >= options.idleTimeoutMs ||
          !(yield* registry.isActive(session.owner))
        ) {
          yield* close(session);
        }
      }
    }).pipe(Effect.repeat(Schedule.spaced(options.sweepIntervalMs)), Effect.forkScoped);
    yield* Stream.runForEach(relay.changes, (host) =>
      Effect.gen(function* () {
        for (const session of sessions.values()) {
          if (session.relaySession.hostId && session.relaySession.hostId !== host.hostId) continue;
          const catalog = yield* relay.list(session.relaySession);
          if (catalog.fingerprint === session.fingerprint) continue;
          session.fingerprint = catalog.fingerprint;
          yield* Effect.tryPromise(() => session.server.sendToolListChanged()).pipe(Effect.ignore);
        }
      }),
    ).pipe(Effect.forkScoped);

    const handler = Effect.gen(function* () {
      const incoming = yield* HttpServerRequest.HttpServerRequest;
      const request = yield* HttpServerRequest.toWeb(incoming);
      const token = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const scope = token ? yield* registry.resolve(token) : undefined;
      const id = request.headers.get("mcp-session-id");
      let session = id ? sessions.get(id) : undefined;
      if (!scope?.capabilities.has("win")) {
        // An unrelated invalid bearer must not be able to kill someone else's session.
        if (session && token && session.bearerHash === tokenHash(token)) yield* close(session);
        return HttpServerResponse.empty({ status: 401 });
      }
      if (
        id &&
        (!session ||
          session.owner !== scope.providerSessionId ||
          session.bearerHash !== tokenHash(token!))
      ) {
        return sessionNotFound();
      }
      if (!session) {
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 400 });
        const relaySession = yield* relay.open(scope);
        const catalog = yield* relay.list(relaySession);
        const server = new Server(
          { name: "t3-win", version: "1.0.0" },
          { capabilities: { tools: { listChanged: true } } },
        );
        const sessionId = NodeCrypto.randomUUID();
        const abort = new AbortController();
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
        });
        const created: Session = {
          id: sessionId,
          owner: scope.providerSessionId,
          bearerHash: tokenHash(token!),
          server,
          transport,
          relaySession,
          abort,
          fingerprint: catalog.fingerprint,
          lastSeen: yield* Clock.currentTimeMillis,
        };
        server.setRequestHandler(ListToolsRequestSchema, async () => {
          const current = await run(relay.list(relaySession));
          return { tools: current.tools };
        });
        // Server.setRequestHandler(tools/call) parses and strips result extensions.
        // The relay validates results; the protocol fallback keeps them intact on the wire.
        server.fallbackRequestHandler = (request, extra) => {
          if (request.method !== "tools/call")
            throw new McpError(ErrorCode.MethodNotFound, "Unknown method");
          const decoded = CallToolRequestSchema.safeParse(request);
          if (!decoded.success)
            throw new McpError(ErrorCode.InvalidParams, "Invalid tools/call request");
          const call = decoded.data;
          const progressToken = call.params._meta?.progressToken;
          return run(
            relay.call(
              relaySession,
              call.params.name,
              call.params.arguments,
              progressToken === undefined
                ? undefined
                : (progress) =>
                    extra.sendNotification({
                      method: "notifications/progress",
                      params: { ...progress, progressToken },
                    }),
            ),
            { signal: AbortSignal.any([abort.signal, extra.signal]) },
          );
        };
        yield* Effect.promise(() => server.connect(transport));
        sessions.set(sessionId, created);
        session = created;
      }
      const current = session;
      current.lastSeen = yield* Clock.currentTimeMillis;
      const response = yield* Effect.tryPromise(() =>
        current.transport.handleRequest(request),
      ).pipe(
        Effect.catch(() => close(current).pipe(Effect.as(new Response(null, { status: 400 })))),
      );
      // A rejected DELETE (e.g. unsupported protocol version) leaves the SDK session alive.
      if ((request.method === "DELETE" && response.ok) || !current.transport.sessionId)
        yield* close(current);
      else if (!id) {
        const siblings = [...sessions.values()].filter(
          (candidate) => candidate.owner === scope.providerSessionId,
        );
        // Map insertion order is creation order, including simultaneous reconnects.
        for (const oldest of siblings.slice(
          0,
          Math.max(0, siblings.length - options.maxSessionsPerScope),
        ))
          yield* close(oldest);
      }
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        // Keep compression middleware and reverse proxies from buffering MCP notifications.
        response.headers.set("cache-control", "no-cache, no-transform");
        response.headers.set("x-accel-buffering", "no");
      }
      return HttpServerResponse.fromWeb(response);
    });
    yield* router.add("POST", "/mcp-win", handler);
    yield* router.add("GET", "/mcp-win", handler);
    yield* router.add("DELETE", "/mcp-win", handler);
  }),
);

export const layer = routes.pipe(Layer.provide(WinMcpRelay.layer));
