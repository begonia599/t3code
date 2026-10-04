// @effect-diagnostics nodeBuiltinImport:off - The official MCP SDK owns native subprocess transports.
// @effect-diagnostics preferSchemaOverJson:off - Redaction preserves the SDK's JSON protocol shapes.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as NodeCrypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  CredentialVaultError,
  HostedMcpConfig,
  type HostedMcpAction,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CredentialVault } from "../credentials/CredentialVault.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { registerMcpSessionDisposer } from "./McpProviderSession.ts";
import {
  adaptResult,
  adaptTool,
  artifactTool,
  exposureFor,
  removeArtifact,
  toolAllowed,
  validateFiles,
} from "./HostedMcpExposure.ts";

const Stored = Schema.fromJsonString(Schema.Array(HostedMcpConfig));
const decodeStored = Schema.decodeUnknownEffect(Stored);
const encodeStored = Schema.encodeSync(Stored);
const unavailable = () =>
  new CredentialVaultError({
    reason:
      "The hosted MCP service is unavailable. Check its command, URL and credential bindings.",
  });
let visibleConfigs: ReadonlyArray<HostedMcpConfig> = [];
export const hostedMcpServers = (instanceId: ProviderInstanceId) =>
  visibleConfigs.filter((config) => config.enabled && config.allowedInstances.includes(instanceId));
const bindings = (config: HostedMcpConfig) =>
  config.transport.type === "stdio" ? config.transport.environment : config.transport.headers;
const names = (config: HostedMcpConfig) => [
  ...new Set(Object.values(bindings(config)).map((binding) => binding.credential)),
];
const redact = <A>(value: A, secrets: ReadonlyArray<string>): A => {
  if (value === undefined) return value;
  let encoded = JSON.stringify(value);
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) encoded = encoded.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
  }
  return JSON.parse(encoded) as A;
};
interface Connection {
  readonly config: HostedMcpConfig;
  signature: string;
  readonly sessionId: string;
  readonly client: Client;
  readonly server: Server;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly replaceCredentials: (
    values: Readonly<Record<string, string>>,
    signature: string,
  ) => Promise<void>;
}
export class HostedMcp extends Context.Service<
  HostedMcp,
  {
    readonly revision: SubscriptionRef.SubscriptionRef<number>;
    readonly snapshot: Effect.Effect<
      ReadonlyArray<{
        config: HostedMcpConfig;
        connections: number;
        status: "stopped" | "running" | "error";
      }>
    >;
    readonly write: (config: HostedMcpConfig) => Effect.Effect<void, CredentialVaultError>;
    readonly action: (input: HostedMcpAction) => Effect.Effect<void, CredentialVaultError>;
    readonly available: (
      scope: McpInvocationScope,
      id?: string,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly id: string;
        readonly label: string;
        readonly allowedTools?: ReadonlyArray<string>;
      }>
    >;
    readonly handle: (
      scope: McpInvocationScope,
      id: string,
      request: Request,
    ) => Effect.Effect<Response, CredentialVaultError>;
  }
>()("t3/mcp/HostedMcp") {}

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore;
  const vault = yield* CredentialVault;
  const stored = yield* store.get("hosted-mcp").pipe(Effect.mapError(unavailable));
  let configs = Option.isSome(stored)
    ? yield* decodeStored(Buffer.from(stored.value).toString("utf8")).pipe(
        Effect.mapError(unavailable),
      )
    : [];
  visibleConfigs = configs;
  const connections = new Map<string, Promise<Connection>>();
  const errors = new Set<string>();
  const revision = yield* SubscriptionRef.make(0);
  const lock = yield* Semaphore.make(1);
  const notify = () => Effect.runPromise(SubscriptionRef.update(revision, (n) => n + 1));
  const close = async (predicate: (connection: Connection) => boolean) => {
    for (const [key, pending] of connections) {
      const connection = await pending.catch(() => undefined);
      if (!connection || predicate(connection)) {
        connections.delete(key);
        if (connection)
          await Promise.allSettled([connection.server.close(), connection.client.close()]);
      }
    }
  };
  const unregister = registerMcpSessionDisposer((sessionId) =>
    close((connection) => connection.sessionId === sessionId),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      unregister();
      await close(() => true);
      if (visibleConfigs === configs) visibleConfigs = [];
    }),
  );
  const persist = (next: ReadonlyArray<HostedMcpConfig>) =>
    store.set("hosted-mcp", new TextEncoder().encode(encodeStored(next))).pipe(
      Effect.mapError(unavailable),
      Effect.tap(() =>
        Effect.sync(() => {
          configs = next;
          visibleConfigs = configs;
        }),
      ),
      Effect.tap(() => SubscriptionRef.update(revision, (n) => n + 1)),
    );
  const write = Effect.fn("HostedMcp.write")(function* (config: HostedMcpConfig) {
    if (config.transport.type === "http") {
      const valid = yield* Effect.try({
        try: () =>
          ["http:", "https:"].includes(
            new URL(config.transport.type === "http" ? config.transport.url : "").protocol,
          ),
        catch: unavailable,
      });
      if (!valid) return yield* Effect.fail(unavailable());
    }
    yield* persist([...configs.filter((entry) => entry.id !== config.id), config]);
    yield* Effect.promise(() => close((connection) => connection.config.id === config.id));
    errors.delete(config.id);
  });
  const action = Effect.fn("HostedMcp.action")(function* (input: HostedMcpAction) {
    const config = configs.find((entry) => entry.id === input.id);
    if (input.action === "delete") yield* persist(configs.filter((entry) => entry.id !== input.id));
    else if (input.action === "stop" && config)
      yield* persist(
        configs.map((entry) => (entry.id === input.id ? { ...entry, enabled: false } : entry)),
      );
    else if (input.action === "restart" && config)
      yield* persist(
        configs.map((entry) => (entry.id === input.id ? { ...entry, enabled: true } : entry)),
      );
    yield* Effect.promise(() => close((connection) => connection.config.id === input.id));
    errors.delete(input.id);
    yield* SubscriptionRef.update(revision, (n) => n + 1);
  });
  const handle = Effect.fn("HostedMcp.handle")(function* (
    scope: McpInvocationScope,
    id: string,
    request: Request,
  ) {
    const config = configs.find(
      (entry) =>
        entry.id === id &&
        entry.enabled &&
        entry.allowedInstances.includes(scope.providerInstanceId),
    );
    if (!config)
      return yield* Effect.fail(
        new CredentialVaultError({
          reason: "This MCP service is not available to this provider instance.",
        }),
      );
    if (scope.script && scope.script.serviceId !== id)
      return new Response("This script is not authorized for this MCP service.", { status: 403 });
    const values = yield* vault.mcpEnvironment(scope, names(config));
    const signature = JSON.stringify([
      config,
      (yield* vault.snapshot).credentials
        .filter((entry) => names(config).includes(entry.name))
        .map((entry) => [entry.name, entry.updatedAt]),
    ]);
    const transportId = request.headers.get("mcp-session-id");
    let initialize = false;
    if (!transportId && request.method === "POST") {
      const message: unknown = yield* Effect.tryPromise({
        try: () => request.clone().json(),
        catch: () => new Error("Invalid MCP request"),
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (message === undefined) return new Response("Invalid MCP JSON request.", { status: 400 });
      initialize =
        typeof message === "object" &&
        message !== null &&
        "method" in message &&
        message.method === "initialize";
    }
    if (!transportId && !initialize)
      return new Response("An MCP session ID is required.", { status: 400 });
    const connectionId = transportId ?? NodeCrypto.randomUUID();
    const key = `${scope.providerSessionId}:${id}:${connectionId}`;
    if (transportId && !connections.has(key))
      return new Response("MCP session not found. Initialize a new session.", { status: 404 });
    if (
      initialize &&
      [...connections.keys()].filter((entry) =>
        entry.startsWith(`${scope.providerSessionId}:${id}:`),
      ).length >= 32
    )
      return new Response("Too many active MCP sessions. Close an unused client.", { status: 429 });
    return yield* Effect.tryPromise({
      try: async () => {
        const previous = await connections.get(key);
        if (previous && previous.signature !== signature) {
          if (JSON.stringify(previous.config) === JSON.stringify(config))
            await previous.replaceCredentials(values, signature);
          else await close((entry) => entry === previous);
        }
        if (!connections.has(key)) {
          const pending = (async () => {
            let client = new Client({ name: "t3-host", version: "1.0.0" });
            const nativeTransport = (credentials: Readonly<Record<string, string>>) => {
              const resolved = Object.fromEntries(
                Object.entries(bindings(config)).map(([name, binding]) => [
                  name,
                  `${binding.prefix ?? ""}${credentials[binding.credential]}`,
                ]),
              );
              return config.transport.type === "stdio"
                ? new StdioClientTransport({
                    command: config.transport.command,
                    args: [...config.transport.args],
                    ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
                    env: {
                      PATH: process.env.PATH ?? "/usr/bin:/bin",
                      HOME: process.env.HOME ?? "/",
                      LANG: process.env.LANG ?? "C.UTF-8",
                      ...resolved,
                    },
                    stderr: "ignore",
                  })
                : new StreamableHTTPClientTransport(new URL(config.transport.url), {
                    requestInit: { headers: resolved, redirect: "error" },
                  });
            };
            const transport = new WebStandardStreamableHTTPServerTransport({
              sessionIdGenerator: () => connectionId,
              enableJsonResponse: true,
            });
            let server: Server | undefined;
            try {
              // SDK 1.x's HTTP transport declares sessionId as string | undefined,
              // while its Transport interface uses an optional string.
              await client.connect(nativeTransport(values) as Transport);
              const capabilities = client.getServerCapabilities();
              const instructions = exposureFor(config).instructions ?? client.getInstructions();
              server = new Server(
                { name: `t3-${id}`, version: "1.0.0" },
                {
                  ...(instructions
                    ? { instructions: redact(instructions, Object.values(values)) }
                    : {}),
                  capabilities: {
                    ...(capabilities?.tools ? { tools: {} } : {}),
                    ...(capabilities?.resources && !scope.script ? { resources: {} } : {}),
                    ...(capabilities?.prompts && !scope.script ? { prompts: {} } : {}),
                  },
                },
              );
              let secrets = Object.values(values);
              const forward = <A>(result: Promise<A>) => {
                const captured = secrets;
                return result
                  .then((value) => redact(value, captured))
                  .catch(() => {
                    throw new Error("The hosted MCP request failed.");
                  });
              };
              if (capabilities?.tools) {
                server.setRequestHandler(ListToolsRequestSchema, async (input, extra) => {
                  const result = await forward(
                    client.listTools(input.params, { signal: extra.signal }),
                  );
                  return {
                    ...result,
                    tools: [...result.tools, ...(config.adapter ? [artifactTool] : [])]
                      .filter((tool) => toolAllowed(config, scope, tool.name))
                      .map((tool) => adaptTool(config, tool)),
                  };
                });
                server.setRequestHandler(CallToolRequestSchema, async (input, extra) => {
                  const name = input.params.name;
                  if (!toolAllowed(config, scope, name))
                    return {
                      isError: true,
                      content: [
                        {
                          type: "text",
                          text: "This tool is not allowed by the service or script authorization.",
                        },
                      ],
                    };
                  try {
                    if (config.adapter && name === artifactTool.name)
                      return await removeArtifact(config, scope, input.params.arguments);
                    await validateFiles(config, scope, name, input.params.arguments);
                  } catch (error) {
                    return {
                      isError: true,
                      content: [
                        {
                          type: "text",
                          text:
                            error instanceof Error
                              ? error.message
                              : "The shared file could not be used.",
                        },
                      ],
                    };
                  }
                  const result = await forward(
                    client.callTool(input.params, CallToolResultSchema, { signal: extra.signal }),
                  );
                  if (scope.script)
                    await Effect.runPromise(
                      Effect.logInfo("MCP script tool called", {
                        service: id,
                        tool: name,
                        instanceId: scope.providerInstanceId,
                        threadId: scope.threadId,
                        scriptId: scope.providerSessionId,
                      }),
                    );
                  return adaptResult(config, name, CallToolResultSchema.parse(result));
                });
              }
              if (capabilities?.resources && !scope.script) {
                server.setRequestHandler(ListResourceTemplatesRequestSchema, (input, extra) =>
                  forward(client.listResourceTemplates(input.params, { signal: extra.signal })),
                );
                server.setRequestHandler(ListResourcesRequestSchema, (input, extra) =>
                  forward(client.listResources(input.params, { signal: extra.signal })),
                );
                server.setRequestHandler(ReadResourceRequestSchema, (input, extra) =>
                  forward(client.readResource(input.params, { signal: extra.signal })),
                );
              }
              if (capabilities?.prompts && !scope.script) {
                server.setRequestHandler(ListPromptsRequestSchema, (input, extra) =>
                  forward(client.listPrompts(input.params, { signal: extra.signal })),
                );
                server.setRequestHandler(GetPromptRequestSchema, (input, extra) =>
                  forward(client.getPrompt(input.params, { signal: extra.signal })),
                );
              }
              await server.connect(transport);
              let rotation = Promise.resolve();
              const connection: Connection = {
                config,
                signature,
                sessionId: scope.providerSessionId,
                get client() {
                  return client;
                },
                server,
                transport,
                replaceCredentials: (updated, nextSignature) => {
                  rotation = rotation
                    .catch(() => undefined)
                    .then(async () => {
                      if (connection.signature === nextSignature) return;
                      const previousClient = client;
                      client = new Client({ name: "t3-host", version: "1.0.0" });
                      await previousClient.close();
                      try {
                        await client.connect(nativeTransport(updated) as Transport);
                      } catch {
                        await client.close();
                        throw unavailable();
                      }
                      secrets = Object.values(updated);
                      connection.signature = nextSignature;
                      trackClose();
                    });
                  return rotation;
                },
              };
              const trackClose = () => {
                const current = client;
                // The SDK exposes a single onclose callback on its protocol object.
                // oxlint-disable-next-line unicorn/prefer-add-event-listener
                current.onclose = () => {
                  if (client !== current) return;
                  if (connections.get(key) === pending) connections.delete(key);
                  void server?.close();
                  void notify();
                };
              };
              trackClose();
              errors.delete(id);
              await notify();
              return connection;
            } catch {
              await Promise.allSettled([client.close(), server?.close()]);
              errors.add(id);
              await notify();
              throw unavailable();
            }
          })();
          connections.set(key, pending);
          void pending.catch(() => {
            if (connections.get(key) === pending) connections.delete(key);
          });
        }
        const connection = await connections.get(key)!;
        const response = await connection.transport.handleRequest(request);
        if (request.method === "DELETE" && response.ok) {
          await close((entry) => entry === connection);
          await notify();
        }
        return response;
      },
      catch: unavailable,
    });
  });
  return HostedMcp.of({
    revision,
    snapshot: Effect.sync(() =>
      configs.map((config) => ({
        config,
        connections: [...connections.keys()].filter((key) => key.includes(`:${config.id}:`)).length,
        status: errors.has(config.id)
          ? ("error" as const)
          : [...connections.keys()].some((key) => key.includes(`:${config.id}:`))
            ? ("running" as const)
            : ("stopped" as const),
      })),
    ),
    write: (config) => lock.withPermits(1)(write(config)),
    action: (input) => lock.withPermits(1)(action(input)),
    available: (scope, id) =>
      Effect.sync(() =>
        configs
          .filter(
            (config) =>
              config.enabled &&
              config.allowedInstances.includes(scope.providerInstanceId) &&
              (!id || config.id === id),
          )
          .map((config) => ({
            id: config.id,
            label: config.label,
            ...(exposureFor(config).allowedTools
              ? { allowedTools: exposureFor(config).allowedTools }
              : {}),
          })),
      ),
    handle,
  });
});
export const layer = Layer.effect(HostedMcp, make);
