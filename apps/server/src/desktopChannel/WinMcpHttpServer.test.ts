// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off preferSchemaOverJson:off - drives the real MCP HTTP route with raw requests to check protocol status codes and SSE bodies.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { WIN_GATEWAY_LABEL_HEADER } from "@t3tools/contracts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  ToolListChangedNotificationSchema,
  ProgressNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Relay from "./WinMcpRelay.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer, HttpMiddleware } from "effect/unstable/http";
import * as Registry from "../mcp/McpSessionRegistry.ts";
import * as WinHttp from "./WinMcpHttpServer.ts";
import { host, scope, startHost, testLayer, toolResult } from "./winMcpTestHelpers.ts";

const registryLayer = (state = { active: true }) =>
  Layer.mock(Registry.McpSessionRegistry)({
    resolve: (token) =>
      Effect.succeed(
        !state.active
          ? undefined
          : token === "owner"
            ? scope
            : token === "other"
              ? { ...scope, providerSessionId: "other" }
              : token === "no-win"
                ? { ...scope, capabilities: new Set() }
                : undefined,
      ),
    isActive: () => Effect.succeed(state.active),
  });
const layer = Layer.mergeAll(
  testLayer(),
  registryLayer(),
  NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
);
const fixture = Effect.gen(function* () {
  yield* HttpRouter.serve(
    WinHttp.routes.pipe(
      Layer.provide(HttpRouter.middleware(HttpMiddleware.compression(), { global: true })),
    ),
    { disableListenLog: true, disableLogger: true },
  ).pipe(Layer.build);
  const server = yield* HttpServer.HttpServer;
  if (typeof server.address === "string" || !("port" in server.address))
    throw new Error("Expected TCP");
  const url = new URL(`http://127.0.0.1:${server.address.port}/mcp-win`);
  const connect = Effect.fn(function* (token = "owner", label?: string) {
    const client = new Client({ name: "test", version: "1" });
    const headers = new Headers({ Authorization: `Bearer ${token}` });
    if (label !== undefined) headers.set(WIN_GATEWAY_LABEL_HEADER, label);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => client.close()));
    yield* Effect.promise(() => client.connect(transport as Parameters<Client["connect"]>[0]));
    return { client, transport, headers };
  });
  const request = (token?: string, id?: string, method = "GET") =>
    Effect.promise(() =>
      fetch(url, {
        method,
        headers: {
          accept: "application/json, text/event-stream",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(id ? { "mcp-session-id": id } : {}),
        },
      }),
    );
  return { connect, request, url };
});

it.effect(
  "serves SDK handshake/list/call over real Node HTTP and delivers list_changed over GET SSE",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const h = yield* startHost();
        const { client } = yield* f.connect();
        expect((yield* Effect.promise(() => client.listTools())).tools[0]?.name).toBe(
          "unity__inspect",
        );
        const progressed = yield* Deferred.make<unknown>();
        const call = yield* Effect.promise(() =>
          client.callTool({ name: "unity__inspect", arguments: { x: 1 } }, undefined, {
            onprogress: (progress) => {
              Deferred.doneUnsafe(progressed, Effect.succeed(progress));
            },
          }),
        ).pipe(Effect.forkScoped);
        const request = yield* h.next;
        yield* h.progress(request.requestId);
        expect(yield* Deferred.await(progressed)).toMatchObject({
          progress: 1,
          total: 2,
          message: "working",
        });
        yield* h.respond(request.requestId, toolResult);
        expect(yield* Fiber.join(call)).toMatchObject({
          isError: true,
          content: [{ type: "text", text: "done" }],
        });
        const changed = yield* Deferred.make<void>();
        client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
          Deferred.doneUnsafe(changed, Effect.void);
          return Promise.resolve();
        });
        // An unsolicited notification can only arrive on the ongoing GET SSE stream.
        yield* h.update({
          enabled: true,
          mcp: {
            version: "2",
            servers: [{ ...host.capabilities.mcp!.servers[0]!, status: "failed", tools: [] }],
          },
        });
        expect((yield* Effect.promise(() => client.listTools())).tools[0]?.name).toBe(
          "unity__inspect",
        );
        expect(yield* Deferred.isDone(changed)).toBe(false);
        yield* h.update({
          enabled: true,
          mcp: {
            version: "1",
            servers: [
              {
                ...host.capabilities.mcp!.servers[0]!,
                tools: [{ name: "new_tool", inputSchema: { type: "object" } }],
              },
            ],
          },
        });
        yield* Deferred.await(changed);
        expect((yield* Effect.promise(() => client.listTools())).tools[0]?.name).toBe(
          "unity__new_tool",
        );
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "requires win bearer, isolates sessions, recycles DELETE and caps each scope at eight sessions",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        for (const token of [undefined, "invalid", "no-win"])
          expect((yield* f.request(token)).status).toBe(401);
        const first = yield* f.connect();
        const firstId = first.transport.sessionId!;
        expect((yield* f.request("other", firstId)).status).toBe(404);
        expect((yield* f.request("invalid", firstId)).status).toBe(401);
        expect((yield* Effect.promise(() => first.client.listTools())).tools).toEqual([]);
        const other = yield* f.connect("other");
        for (let i = 0; i < 8; i++) yield* f.connect();
        expect((yield* f.request("owner", firstId)).status).toBe(404);
        expect((yield* Effect.promise(() => other.client.listTools())).tools).toEqual([]);
        const last = yield* f.connect();
        const lastId = last.transport.sessionId!;
        yield* Effect.promise(() => last.transport.terminateSession());
        expect((yield* f.request("owner", lastId)).status).toBe(404);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect(
  "binds normalized initialize labels to each session and ignores later header changes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const h = yield* startHost();
        const first = yield* f.connect("owner", "a".repeat(210));
        const second = yield* f.connect("owner", "task-b");
        const unlabeled = yield* f.connect();
        first.headers.set(WIN_GATEWAY_LABEL_HEADER, "task-b");
        second.headers.delete(WIN_GATEWAY_LABEL_HEADER);
        unlabeled.headers.set(WIN_GATEWAY_LABEL_HEADER, "added-later");
        for (const [session, label] of [
          [first, "a".repeat(200)],
          [second, "task-b"],
          [unlabeled, undefined],
          [first, "a".repeat(200)],
        ] as const) {
          const call = yield* Effect.promise(() =>
            session.client.callTool({ name: "unity__inspect" }),
          ).pipe(Effect.forkScoped);
          const request = yield* h.next;
          if (request.type !== "request") throw new Error("Expected request");
          expect(request.context).toEqual({
            threadId: scope.threadId,
            provider: scope.providerInstanceId,
            projectId: "project",
            workspaceRoot: "/project",
            ...(label === undefined ? {} : { label }),
          });
          yield* h.respond(request.requestId, toolResult);
          expect(yield* Fiber.join(call)).toMatchObject({
            isError: true,
            content: [{ type: "text", text: "done" }],
          });
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("evicts the least recently used session instead of the earliest created session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const first = yield* f.connect();
      yield* TestClock.adjust(1);
      const second = yield* f.connect();
      yield* TestClock.adjust(1);
      yield* Effect.promise(() => first.client.listTools());
      const third = yield* f.connect();
      expect((yield* f.request("owner", second.transport.sessionId!)).status).toBe(404);
      expect((yield* Effect.promise(() => first.client.listTools())).tools).toEqual([]);
      expect((yield* Effect.promise(() => third.client.listTools())).tools).toEqual([]);
    }),
  ).pipe(
    Effect.provide(layer),
    Effect.provideService(WinHttp.WinMcpHttpOptions, {
      maxSessionsPerScope: 2,
      idleTimeoutMs: 6 * 60 * 60_000,
      sweepIntervalMs: 30_000,
    }),
  ),
);

it.effect("cancels an in-flight desktop call on SDK cancellation and DELETE", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const h = yield* startHost();
      for (const mode of ["cancel", "delete"]) {
        const { client, transport } = yield* f.connect();
        const controller = new AbortController();
        const call = yield* Effect.promise(() =>
          client
            .callTool({ name: "unity__inspect" }, undefined, { signal: controller.signal })
            .catch(() => undefined),
        ).pipe(Effect.forkScoped);
        const request = yield* h.next;
        if (mode === "cancel") controller.abort();
        else {
          yield* Effect.promise(() => transport.terminateSession());
          controller.abort();
        }
        expect(yield* h.next).toEqual({ type: "cancel", requestId: request.requestId });
        yield* Fiber.join(call);
      }
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("reclaims idle sessions and cancels their calls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const { transport } = yield* f.connect();
      const id = transport.sessionId!;
      yield* TestClock.adjust(6 * 60 * 60_000 + 30_000);
      expect((yield* f.request("owner", id)).status).toBe(404);
    }),
  ).pipe(Effect.provide(layer)),
);

for (const mode of ["resolve", "sweep"]) {
  it.effect(`reclaims revoked bearer sessions via ${mode}`, () => {
    const state = { active: true };
    return Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const h = yield* startHost();
        const { client, transport } = yield* f.connect();
        const id = transport.sessionId!;
        const abort = new AbortController();
        const call = yield* Effect.promise(() =>
          client
            .callTool({ name: "unity__inspect" }, undefined, { signal: abort.signal })
            .catch(() => undefined),
        ).pipe(Effect.forkScoped);
        const request = yield* h.next;
        state.active = false;
        if (mode === "resolve") expect((yield* f.request("owner", id)).status).toBe(401);
        else yield* TestClock.adjust(30000);
        expect(yield* h.next).toEqual({ type: "cancel", requestId: request.requestId });
        state.active = true;
        expect((yield* f.request("owner", id)).status).toBe(404);
        abort.abort();
        yield* Fiber.join(call);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          testLayer(),
          registryLayer(state),
          NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
        ),
      ),
    );
  });
}

it.effect("does not send progress without a progress token, and explains unknown tools", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const h = yield* startHost();
      const { client } = yield* f.connect();
      let progressCount = 0;
      client.setNotificationHandler(ProgressNotificationSchema, () => {
        progressCount++;
        return Promise.resolve();
      });
      const call = yield* Effect.promise(() => client.callTool({ name: "unity__inspect" })).pipe(
        Effect.forkScoped,
      );
      const request = yield* h.next;
      yield* h.progress(request.requestId);
      yield* h.respond(request.requestId, toolResult);
      yield* Fiber.join(call);
      expect(progressCount).toBe(0);
      expect(yield* Effect.promise(() => client.callTool({ name: "unknown" }))).toMatchObject({
        isError: true,
        content: [{ text: expect.stringContaining("MCP_TOOL_NOT_FOUND") }],
      });
      expect(yield* h.queued).toBe(0);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("preserves local annotations and result extensions on the HTTP wire", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const h = yield* startHost();
      const { transport } = yield* f.connect();
      const rpc = (method: string, params: unknown) =>
        Effect.promise(async () => {
          const response = await fetch(f.url, {
            method: "POST",
            headers: {
              authorization: "Bearer owner",
              "mcp-session-id": transport.sessionId!,
              accept: "application/json, text/event-stream",
              "content-type": "application/json",
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 999, method, params }),
          });
          const text = await response.text();
          const data = text.split("\n").find((line) => line.startsWith("data: "));
          if (!data) throw new Error("Expected SSE result");
          return JSON.parse(data.slice(6));
        });
      expect(yield* rpc("tools/list", {})).toMatchObject({
        result: {
          tools: [{ annotations: { readOnlyHint: true, localExtension: { version: 1 } } }],
        },
      });
      const call = yield* rpc("tools/call", { name: "unity__inspect" }).pipe(Effect.forkScoped);
      const request = yield* h.next;
      yield* h.respond(request.requestId, toolResult);
      expect(yield* Fiber.join(call)).toMatchObject({ result: toolResult });
    }),
  ).pipe(Effect.provide(layer)),
);

// Keep the real route, SDK and relay list/call behavior, while controlling GET
// connections and catalog announcements. The receipt waits for the route to consume
// each announcement, so opening GET cannot race ahead of the catalog change.
const rawFixture = Effect.gen(function* () {
  const relay = yield* Relay.WinMcpRelay;
  const processed = yield* Queue.unbounded<void>();
  const changes = yield* Queue.unbounded<typeof host>();
  const { handler, dispose } = HttpRouter.toWebHandler(
    WinHttp.routes.pipe(
      Layer.provide(registryLayer()),
      Layer.provide(
        Layer.succeed(Relay.WinMcpRelay, {
          ...relay,
          changes: Stream.fromQueue(changes).pipe(
            Stream.flatMap((change) =>
              Stream.make(change).pipe(
                Stream.concat(
                  Stream.fromEffect(Queue.offer(processed, undefined)).pipe(Stream.drain),
                ),
              ),
            ),
          ),
        }),
      ),
    ),
    { disableLogger: true },
  );
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  let sessionId: string | undefined;
  const request = (method: string, body?: unknown) =>
    Effect.promise(() =>
      handler(
        new Request("http://localhost/mcp-win", {
          method,
          headers: {
            authorization: "Bearer owner",
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      ),
    );
  const rpc = (id: string | number, method: string, params = {}) =>
    request("POST", { jsonrpc: "2.0", id, method, params });
  const initialized = yield* rpc(0, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "raw", version: "1" },
  });
  sessionId = initialized.headers.get("mcp-session-id")!;
  yield* Effect.promise(() => initialized.text());
  yield* request("POST", { jsonrpc: "2.0", method: "notifications/initialized" });
  return {
    request,
    rpc,
    changed: Queue.offer(changes, host).pipe(Effect.andThen(Queue.take(processed))),
  };
});

const readSse = (response: Response) =>
  Effect.promise(async () => {
    const reader = response.body!.getReader();
    try {
      let text = "";
      while (!text.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("SSE ended before a message");
        text += new TextDecoder().decode(chunk.value);
      }
      const data = text.split("\n").find((line) => line.startsWith("data: "));
      if (!data) throw new Error("Expected SSE data");
      return JSON.parse(data.slice(6));
    } finally {
      reader.releaseLock();
    }
  });

it.effect("cancels only the disconnected POST and releases SDK request mappings", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handled = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
      yield* Effect.addFinalizer(() => Effect.sync(() => handled.mockRestore()));
      const h = yield* startHost();
      const f = yield* rawFixture;
      const get = yield* f.request("GET");
      expect((yield* f.request("GET")).status).toBe(409);
      const first = yield* f.rpc("cancel-me", "tools/call", { name: "unity__inspect" });
      const firstCall = yield* h.next;
      const second = yield* f.rpc(2, "tools/call", { name: "unity__inspect" });
      const secondCall = yield* h.next;
      const transport = handled.mock.contexts[0] as unknown as {
        _requestToStreamMapping: Map<string | number, string>;
        _requestResponseMap: Map<string | number, unknown>;
        _streamMapping: Map<string, unknown>;
      };
      const streamId = transport._requestToStreamMapping.get("cancel-me")!;
      expect(streamId).toBeDefined();
      yield* Effect.promise(() => first.body!.cancel());
      expect(transport._requestToStreamMapping.has("cancel-me")).toBe(false);
      expect(transport._requestResponseMap.has("cancel-me")).toBe(false);
      expect(transport._streamMapping.has(streamId)).toBe(false);
      expect(yield* h.next).toEqual({ type: "cancel", requestId: firstCall.requestId });
      yield* h.respond(secondCall.requestId, toolResult);
      expect(yield* readSse(second)).toMatchObject({ id: 2, result: toolResult });
      const third = yield* f.rpc(3, "tools/call", { name: "unity__inspect" });
      const thirdCall = yield* h.next;
      yield* h.respond(thirdCall.requestId, toolResult);
      expect(yield* readSse(third)).toMatchObject({ id: 3, result: toolResult });
      // The POST disconnect must leave the standalone GET stream usable.
      yield* h.update({ enabled: true, mcp: { version: "2", servers: [] } });
      yield* f.changed;
      expect(yield* readSse(get)).toMatchObject({ method: "notifications/tools/list_changed" });
      yield* Effect.promise(() => get.body!.cancel());
      expect(transport._requestToStreamMapping.size).toBe(0);
      expect(transport._requestResponseMap.size).toBe(0);
    }),
  ).pipe(Effect.provide(testLayer())),
);

for (const reconnect of [false, true]) {
  it.effect(
    reconnect
      ? "replays catalog changes after the GET stream disconnects"
      : "notifies a later GET stream when Unity recovers from an empty catalog",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* startHost({
            ...host,
            capabilities: { enabled: true, mcp: { version: "empty", servers: [] } },
          });
          const f = yield* rawFixture;
          expect(yield* readSse(yield* f.rpc(1, "tools/list"))).toMatchObject({
            result: { tools: [] },
          });
          if (reconnect) {
            const get = yield* f.request("GET");
            expect(get.status).toBe(200);
            yield* Effect.promise(() => get.body!.cancel());
          }
          yield* h.update(host.capabilities);
          yield* f.changed;
          const get = yield* f.request("GET");
          expect(get.status).toBe(200);
          expect(yield* readSse(get)).toMatchObject({ method: "notifications/tools/list_changed" });
          expect(yield* readSse(yield* f.rpc(2, "tools/list"))).toMatchObject({
            result: { tools: [{ name: "unity__inspect" }] },
          });
          yield* Effect.promise(() => get.body!.cancel());
          // A resolved send is not an acknowledgement: replay even without another change.
          const again = yield* f.request("GET");
          expect(yield* readSse(again)).toMatchObject({
            method: "notifications/tools/list_changed",
          });
          yield* Effect.promise(() => again.body!.cancel());
        }),
      ).pipe(Effect.provide(testLayer())),
  );
}

it.effect("retries a failed catalog notification when GET reconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* startHost();
      const f = yield* rawFixture;
      const get = yield* f.request("GET");
      const send = vi
        .spyOn(Server.prototype, "sendToolListChanged")
        .mockRejectedValueOnce(new Error("disconnected"));
      yield* Effect.addFinalizer(() => Effect.sync(() => send.mockRestore()));
      yield* h.update({ enabled: true, mcp: { version: "empty", servers: [] } });
      yield* f.changed;
      expect(send).toHaveBeenCalledTimes(1);
      yield* Effect.promise(() => get.body!.cancel());
      const again = yield* f.request("GET");
      expect(yield* readSse(again)).toMatchObject({ method: "notifications/tools/list_changed" });
      expect(send).toHaveBeenCalledTimes(2);
      yield* Effect.promise(() => again.body!.cancel());
    }),
  ).pipe(Effect.provide(testLayer())),
);

it.effect("cleans completed and pending request mappings when a batch POST disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const handled = vi.spyOn(WebStandardStreamableHTTPServerTransport.prototype, "handleRequest");
      yield* Effect.addFinalizer(() => Effect.sync(() => handled.mockRestore()));
      const h = yield* startHost();
      const f = yield* rawFixture;
      const response = yield* f.request(
        "POST",
        [1, "1"].map((id) => ({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "unity__inspect" },
        })),
      );
      const first = yield* h.next;
      const second = yield* h.next;
      yield* h.respond(first.requestId, toolResult);
      expect(yield* readSse(response)).toMatchObject({ id: 1, result: toolResult });
      const transport = handled.mock.contexts[0] as unknown as {
        _requestToStreamMapping: Map<string | number, string>;
        _requestResponseMap: Map<string | number, unknown>;
      };
      expect(transport._requestResponseMap.has(1)).toBe(true);
      // A second POST cannot overwrite the live batch's cancellation controller.
      expect((yield* f.rpc("1", "tools/call", { name: "unity__inspect" })).status).toBe(400);
      yield* Effect.promise(() => response.body!.cancel());
      expect(transport._requestResponseMap.size).toBe(0);
      expect(transport._requestToStreamMapping.size).toBe(0);
      expect(yield* h.next).toEqual({ type: "cancel", requestId: second.requestId });
    }),
  ).pipe(Effect.provide(testLayer())),
);
