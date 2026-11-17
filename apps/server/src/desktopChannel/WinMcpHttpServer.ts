import * as NodeCrypto from "node:crypto";
import { normalizeWinLabel, WIN_GATEWAY_LABEL_HEADER } from "@t3tools/contracts";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  JSONRPCRequestSchema,
  type RequestId,
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
    maxSessionsPerScope: 8,
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
  readonly requests: Map<RequestId, AbortController>;
  fingerprint: string;
  catalogChanged: boolean;
  notificationStream: object | undefined;
  // Last enqueued version on this GET connection, not a client acknowledgement.
  notifiedFingerprint: string | undefined;
  lastSeen: number;
}
const tokenHash = (token: string) => NodeCrypto.createHash("sha256").update(token).digest("hex");
// Same body the MCP SDK sends, so clients recognize an expired session and re-initialize.
const sessionNotFound = () =>
  HttpServerResponse.jsonUnsafe(
    { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null },
    { status: 404 },
  );

// SDK 1.29.0 only removes the stream on body.cancel(); a late response then
// retains its request/response entries. Keep this version-sensitive cleanup here.
function releaseCancelledRequests(
  transport: WebStandardStreamableHTTPServerTransport,
  ids: readonly RequestId[],
) {
  const fields = transport as unknown as Record<string, unknown>;
  for (const id of ids) {
    if (fields._requestToStreamMapping instanceof Map) {
      // Future SDKs may rename either map; cancellation must still reach the relay.
      if (fields._streamMapping instanceof Map) transport.closeSSEStream(id);
      fields._requestToStreamMapping.delete(id);
    }
    if (fields._requestResponseMap instanceof Map) fields._requestResponseMap.delete(id);
  }
}

function observeResponse(response: Response, finish: (cancelled: boolean) => void) {
  if (!response.body) {
    finish(false);
    return response;
  }
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              finish(false);
              controller.close();
            } else controller.enqueue(chunk.value);
          } catch (error) {
            finish(true);
            controller.error(error);
          }
        },
        cancel(reason) {
          finish(true);
          return reader.cancel(reason);
        },
      },
      { highWaterMark: 0 },
    ),
    response,
  );
}

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
    const notifyCatalog = (session: Session) =>
      Effect.gen(function* () {
        const stream = session.notificationStream;
        const fingerprint = session.fingerprint;
        if (!stream || session.notifiedFingerprint === fingerprint) return;
        yield* Effect.tryPromise(() => session.server.sendToolListChanged()).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (session.notificationStream === stream) session.notifiedFingerprint = fingerprint;
            }),
          ),
          Effect.ignore,
        );
      });
    yield* Stream.runForEach(relay.changes, (host) =>
      Effect.gen(function* () {
        for (const session of sessions.values()) {
          if (session.relaySession.hostId && session.relaySession.hostId !== host.hostId) continue;
          const catalog = yield* relay.list(session.relaySession);
          if (catalog.fingerprint === session.fingerprint) continue;
          session.fingerprint = catalog.fingerprint;
          session.catalogChanged = true;
          yield* notifyCatalog(session);
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
        const label = normalizeWinLabel(request.headers.get(WIN_GATEWAY_LABEL_HEADER));
        const relaySession = yield* relay.open(scope, label);
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
          requests: new Map(),
          fingerprint: catalog.fingerprint,
          catalogChanged: false,
          notificationStream: undefined,
          notifiedFingerprint: undefined,
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
          const responseSignal = created.requests.get(extra.requestId)?.signal;
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
            {
              signal: AbortSignal.any([
                abort.signal,
                extra.signal,
                ...(responseSignal ? [responseSignal] : []),
              ]),
            },
          );
        };
        yield* Effect.promise(() => server.connect(transport));
        sessions.set(sessionId, created);
        session = created;
      }
      const current = session;
      current.lastSeen = yield* Clock.currentTimeMillis;
      // Parse once, and let the SDK retain responsibility for protocol validation.
      const parsedBody: unknown =
        request.method === "POST"
          ? yield* Effect.promise(() => request.json().catch(() => undefined))
          : undefined;
      const ids = (Array.isArray(parsedBody) ? parsedBody : [parsedBody]).flatMap((message) => {
        const decoded = JSONRPCRequestSchema.safeParse(message);
        return decoded.success ? [decoded.data.id] : [];
      });
      if (new Set(ids).size !== ids.length || ids.some((id) => current.requests.has(id))) {
        return HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: ErrorCode.InvalidRequest, message: "Request id already in use" },
          },
          { status: 400 },
        );
      }
      const postAbort = new AbortController();
      for (const id of ids) current.requests.set(id, postAbort);
      let finished = false;
      const finishPost = (cancelled: boolean) => {
        if (finished) return;
        finished = true;
        // Delete before aborting: the handler's rejection must not recreate SDK state.
        if (cancelled) releaseCancelledRequests(current.transport, ids);
        for (const id of ids) current.requests.delete(id);
        if (cancelled) postAbort.abort();
      };
      if (ids.length > 0) yield* Effect.addFinalizer(() => Effect.sync(() => finishPost(true)));
      let response = yield* Effect.tryPromise(() =>
        current.transport.handleRequest(request, { parsedBody }),
      ).pipe(
        Effect.catch(() => close(current).pipe(Effect.as(new Response(null, { status: 400 })))),
      );
      if (ids.length > 0) response = observeResponse(response, finishPost);
      if (request.method === "GET" && response.ok && response.body) {
        const stream = {};
        current.notificationStream = stream;
        current.notifiedFingerprint = undefined;
        const finishGet = (cancelled: boolean) => {
          if (current.notificationStream !== stream) return;
          current.notificationStream = undefined;
          current.notifiedFingerprint = undefined;
          if (cancelled) current.transport.closeStandaloneSSEStream();
        };
        // Also release a GET disconnected before the HTTP server starts reading its body.
        yield* Effect.addFinalizer(() => Effect.sync(() => finishGet(true)));
        response = observeResponse(response, finishGet);
        // Enqueuing is not a client acknowledgement. After any catalog change,
        // replay on every GET reconnect, even if the previous send resolved.
        if (current.catalogChanged) yield* notifyCatalog(current);
      }
      // A rejected DELETE (e.g. unsupported protocol version) leaves the SDK session alive.
      if ((request.method === "DELETE" && response.ok) || !current.transport.sessionId)
        yield* close(current);
      else if (!id) {
        const siblings = [...sessions.values()]
          .filter(
            (candidate) => candidate.owner === scope.providerSessionId && candidate !== current,
          )
          .sort((a, b) => a.lastSeen - b.lastSeen);
        for (const oldest of siblings.slice(
          0,
          Math.max(0, siblings.length + 1 - options.maxSessionsPerScope),
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
