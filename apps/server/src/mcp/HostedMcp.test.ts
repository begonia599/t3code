// @effect-diagnostics nodeBuiltinImport:off - Native SDK transports are verified against real subprocesses.
// @effect-diagnostics preferSchemaOverJson:off - The SDK owns the MCP JSON codecs in these fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type HostedMcpConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpRouter } from "effect/unstable/http";
import * as Config from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Vault from "../credentials/CredentialVault.ts";
import { HostedMcp, layer as hostedLayer } from "./HostedMcp.ts";
import {
  disposeMcpSession,
  readMcpProviderSession,
  setMcpProviderSession,
  clearMcpProviderSession,
} from "./McpProviderSession.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { hostedMcpRouteLayer } from "./hostedHttp.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("hosted-test"),
  threadId: ThreadId.make("hosted-thread"),
  providerSessionId: "hosted-session-a",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  capabilities: new Set(),
  issuedAt: 1,
};
const dependencies = hostedLayer.pipe(
  Layer.provideMerge(Vault.layer),
  Layer.provideMerge(SecretStore.layer),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-hosted-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = `
import { Server } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/index.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListResourceTemplatesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/types.js"))};
const server = new Server({name:'fixture',version:'1'}, {instructions:'Use the identity tool in this environment.',capabilities:{tools:{},resources:{},prompts:{}}});
server.setRequestHandler(ListToolsRequestSchema, async () => ({tools:[{name:'identity',inputSchema:{type:'object'}}]}));
server.setRequestHandler(CallToolRequestSchema, async () => ({content:[{type:'text',text:JSON.stringify({pid:process.pid,key:process.env.API_KEY,home:process.env.HOME,leakedHost:process.env.T3_HOST_TEST_SECRET ?? null})}]}));
server.setRequestHandler(ListResourcesRequestSchema, async () => ({resources:[{uri:'fixture://value',name:'fixture'}]}));
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({resourceTemplates:[{uriTemplate:'fixture://{name}',name:'dynamic fixture'}]}));
server.setRequestHandler(ReadResourceRequestSchema, async () => ({contents:[{uri:'fixture://value',text:process.env.API_KEY}]}));
server.setRequestHandler(ListPromptsRequestSchema, async () => ({prompts:[{name:'fixture'}]}));
server.setRequestHandler(GetPromptRequestSchema, async () => ({messages:[{role:'user',content:{type:'text',text:'fixture prompt'}}]}));
await server.connect(new StdioServerTransport());
`;
const makeWeb = (
  manager: HostedMcp["Service"],
  sessions: ReadonlyMap<string, McpInvocationScope>,
) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        hostedMcpRouteLayer.pipe(
          Layer.provide(Layer.succeed(HostedMcp, manager)),
          Layer.provide(
            Layer.mock(McpSessionRegistry)({
              resolveHosted: (token) => Effect.succeed(sessions.get(token)),
            }),
          ),
        ),
        { disableLogger: true },
      ),
    ),
    (web) => Effect.promise(() => web.dispose()),
  );

it.effect(
  "hosts stdio under T3, forwards native tools/resources/prompts, isolates sessions and tears down captured processes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-mcp-fixture-" });
      const file = `${directory}/fixture.mjs`;
      yield* fs.writeFileString(file, fixture);
      const vault = yield* Vault.CredentialVault;
      const manager = yield* HostedMcp;
      yield* vault.write({
        name: "NAI_TOKEN",
        value: Redacted.make("fixture-nai-private-token"),
        description: "",
        valueType: "token",
        allowedInstances: [scope.providerInstanceId],
      });
      const config: HostedMcpConfig = {
        id: "nai",
        label: "NAI fixture",
        enabled: true,
        allowedInstances: [scope.providerInstanceId],
        transport: {
          type: "stdio",
          command: process.execPath,
          args: [file],
          environment: { API_KEY: { credential: "NAI_TOKEN" } },
        },
      };
      yield* manager.write(config);
      setMcpProviderSession({
        ...scope,
        endpoint: "http://127.0.0.1:5000/mcp",
        authorizationHeader: "Bearer fixture-session",
      });
      expect(readMcpProviderSession(scope.threadId, "10.2.0.1")?.hostedServers).toEqual([
        { name: "t3-hosted-nai", endpoint: "http://10.2.0.1:5000/mcp/hosted/nai" },
      ]);
      clearMcpProviderSession(scope.threadId);
      const sessions = new Map<string, McpInvocationScope>();
      const web = yield* makeWeb(manager, sessions);
      expect(
        (yield* Effect.promise(() => web.handler(new Request("http://t3.test/mcp/hosted/nai"))))
          .status,
      ).toBe(401);
      expect(
        (yield* Effect.promise(() =>
          web.handler(
            new Request("http://t3.test/mcp/hosted/nai", {
              headers: { origin: "https://untrusted.example", authorization: "Bearer ignored" },
            }),
          ),
        )).status,
      ).toBe(403);
      const pids = yield* Effect.tryPromise(async () => {
        const clients: Client[] = [];
        const connect = async (session: McpInvocationScope) => {
          const client = new Client({ name: "native-harness", version: "1" });
          clients.push(client);
          sessions.set(session.providerSessionId, session);
          const transport = new StreamableHTTPClientTransport(
            new URL("http://t3.test/mcp/hosted/nai"),
            {
              fetch: (url, init) => web.handler(new Request(url, init)),
              requestInit: { headers: { authorization: `Bearer ${session.providerSessionId}` } },
            },
          );
          await client.connect(transport as Transport);
          return client;
        };
        try {
          const a = await connect(scope);
          const c = await connect(scope);
          expect(c.getInstructions()).toBe("Use the identity tool in this environment.");
          const b = await connect({
            ...scope,
            providerSessionId: "hosted-session-b",
            threadId: ThreadId.make("thread-b"),
          });
          expect((await a.listTools()).tools[0]?.name).toBe("identity");
          const parseIdentity = async (client: Client) => {
            const result = await client.callTool({ name: "identity" });
            const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
            expect(text).not.toContain("fixture-nai-private-token");
            const identity = JSON.parse(text!);
            expect(identity.key).toBe("[REDACTED]");
            expect(identity.home).toBe(process.env.HOME);
            expect(identity.leakedHost).toBe(null);
            return identity.pid as number;
          };
          const pidA = await parseIdentity(a);
          const pidC = await parseIdentity(c);
          expect(pidC).not.toBe(pidA);
          await c.listTools();
          await a.listTools();
          const pidB = await parseIdentity(b);
          expect(pidA).not.toBe(pidB);
          const script = await connect({
            ...scope,
            providerSessionId: "restricted-script",
            capabilities: new Set(),
            script: { serviceId: "nai", tools: new Set(["identity"]) },
          });
          expect(script.getServerCapabilities()?.resources).toBeUndefined();
          expect((await script.listTools()).tools.map((tool) => tool.name)).toEqual(["identity"]);
          expect((await script.callTool({ name: "unapproved" })).isError).toBe(true);
          const scriptPid = await parseIdentity(script);
          await disposeMcpSession("restricted-script");
          const resource = (await a.readResource({ uri: "fixture://value" })).contents[0];
          expect((await a.listResourceTemplates()).resourceTemplates[0]?.uriTemplate).toBe(
            "fixture://{name}",
          );
          expect(resource && "text" in resource ? resource.text : undefined).toBe("[REDACTED]");
          expect((await a.getPrompt({ name: "fixture" })).messages).toHaveLength(1);
          await disposeMcpSession(scope.providerSessionId);
          expect((await b.listTools()).tools).toHaveLength(1);
          return [pidA, pidB, pidC, scriptPid];
        } finally {
          await Promise.allSettled(clients.map((client) => client.close()));
        }
      });
      expect((yield* manager.snapshot)[0]?.connections).toBe(1);
      yield* manager.action({ id: config.id, action: "stop" });
      expect((yield* manager.snapshot)[0]).toMatchObject({
        connections: 0,
        config: { enabled: false },
      });
      for (const pid of pids) expect(yield* fs.exists(`/proc/${pid}`)).toBe(false);
      expect(
        (yield* manager
          .handle(scope, config.id, new Request("http://t3.test/mcp/hosted/nai"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* manager.action({ id: config.id, action: "restart" });
      expect((yield* manager.snapshot)[0]?.config.enabled).toBe(true);
      expect(
        (yield* manager
          .handle(
            { ...scope, providerInstanceId: ProviderInstanceId.make("codex") },
            config.id,
            new Request("http://t3.test/mcp/hosted/nai"),
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* manager.action({ id: config.id, action: "delete" });
      expect(yield* manager.snapshot).toEqual([]);
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);

it.effect(
  "connects remote Streamable HTTP with vault-bound headers and replaces credentials on subsequent requests",
  () =>
    Effect.gen(function* () {
      const vault = yield* Vault.CredentialVault;
      const manager = yield* HostedMcp;
      const authorizations: string[] = [];
      const native = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = NodeHttp.createServer((request, response) => {
            if (request.method === "GET") {
              response.writeHead(405).end();
              return;
            }
            authorizations.push(request.headers.authorization ?? "");
            let body = "";
            request.on("data", (chunk) => {
              body += chunk;
            });
            request.on("end", () => {
              const message = JSON.parse(body);
              if (message.id === undefined) {
                response.writeHead(202).end();
                return;
              }
              const result =
                message.method === "initialize"
                  ? {
                      protocolVersion: "2025-06-18",
                      capabilities: { tools: {} },
                      serverInfo: { name: "remote-fixture", version: "1" },
                    }
                  : message.method === "tools/list"
                    ? { tools: [{ name: "remote", inputSchema: { type: "object" } }] }
                    : { content: [{ type: "text", text: request.headers.authorization ?? "" }] };
              response.writeHead(200, { "content-type": "application/json" });
              response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
            });
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          return server;
        }),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
              }),
          ),
      );
      const address = native.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP fixture");
      yield* vault.write({
        name: "SERVICE_TOKEN",
        value: Redacted.make("fixture-remote-key"),
        description: "",
        valueType: "token",
        allowedInstances: [scope.providerInstanceId],
      });
      yield* manager.write({
        id: "remote",
        label: "Remote fixture",
        enabled: true,
        allowedInstances: [scope.providerInstanceId],
        transport: {
          type: "http",
          url: `http://127.0.0.1:${address.port}/mcp`,
          headers: { Authorization: { credential: "SERVICE_TOKEN", prefix: "Bearer " } },
        },
      });
      const web = yield* makeWeb(manager, new Map([[scope.providerSessionId, scope]]));
      const client = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const nativeClient = new Client({ name: "harness", version: "1" });
          try {
            await nativeClient.connect(
              new StreamableHTTPClientTransport(new URL("http://t3.test/mcp/hosted/remote"), {
                fetch: (url, init) => web.handler(new Request(url, init)),
                requestInit: { headers: { authorization: `Bearer ${scope.providerSessionId}` } },
              }) as Transport,
            );
            return nativeClient;
          } catch (error) {
            await nativeClient.close();
            throw error;
          }
        }),
        (client) =>
          Effect.promise(async () => {
            await client.close();
            await disposeMcpSession(scope.providerSessionId);
          }),
      );
      yield* Effect.tryPromise(async () => {
        expect((await client.listTools()).tools[0]?.name).toBe("remote");
        expect(JSON.stringify(await client.callTool({ name: "remote" }))).toContain(
          "Bearer [REDACTED]",
        );
        expect(authorizations.length).toBeGreaterThan(0);
        expect(authorizations.every((header) => header === "Bearer fixture-remote-key")).toBe(true);
      });
      yield* vault.write({
        name: "SERVICE_TOKEN",
        value: Redacted.make("fixture-updated-key"),
        description: "",
        valueType: "token",
        allowedInstances: [scope.providerInstanceId],
      });
      authorizations.length = 0;
      yield* Effect.tryPromise(async () => {
        const result = await client.callTool({ name: "remote" });
        expect(JSON.stringify(result)).toContain("Bearer [REDACTED]");
        expect(JSON.stringify(result)).not.toContain("fixture-updated-key");
        expect(authorizations.length).toBeGreaterThan(0);
        expect(authorizations.every((header) => header === "Bearer fixture-updated-key")).toBe(
          true,
        );
      });
      yield* vault.action({ action: "delete", name: "SERVICE_TOKEN" });
      expect(
        (yield* manager
          .handle(scope, "remote", new Request("http://t3.test/mcp/hosted/remote"))
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
