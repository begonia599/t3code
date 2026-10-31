// @effect-diagnostics nodeBuiltinImport:off - Local HTTP fixture exercises redirect handling.
import { describe, expect, it } from "@effect/vitest";
import * as NodeHttp from "node:http";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderInstanceConfig,
  type ProviderGatewayConfig,
  ServerProvider,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { gatewayHeaders, withoutGateway } from "@t3tools/shared/providerGateway";
import { mergeProviderSnapshot } from "./Layers/ProviderRegistry.ts";
import { hydrateCachedProvider } from "./providerStatusCache.ts";
import { projectGatewayInstance, gatewaySnapshot } from "./GatewayRuntime.ts";
import { makeClaudeGatewaySettingsWriter } from "./ClaudeGatewaySettings.ts";
import { inspectGatewayStream, probeGateway, resolveGatewaySecrets } from "./ProviderGateway.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { redactServerSettingsForClient } from "../serverSettings.ts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

const decodeInstance = Schema.decodeSync(ProviderInstanceConfig);
const decodeProviderSnapshot = Schema.decodeSync(Schema.fromJsonString(ServerProvider));
const decodeSessionSettings = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      env: Schema.Record(Schema.String, Schema.String),
      alwaysThinkingEnabled: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

const gateway = (protocol: "anthropic" | "responses" = "anthropic"): ProviderGatewayConfig => ({
  enabled: true,
  protocol,
  baseUrl: "https://gateway.example/custom/prefix/",
  auth: "bearer",
  model: "vendor/model-v2",
  models: ["vendor/second"],
  roles: { haiku: "vendor/small" },
  headers: [{ name: "X-Workspace", variable: "T3_GATEWAY_HEADER_0" }],
});
const instance = (protocol: "anthropic" | "responses" = "anthropic"): ProviderInstanceConfig => ({
  driver: ProviderDriverKind.make(protocol === "anthropic" ? "claudeAgent" : "codex"),
  config: {
    homePath: "/untouched/native-home",
    launchArgs: "--config 'other=\"keep\"'",
    customModels: ["prior-model"],
  },
  gateway: gateway(protocol),
  environment: [
    { name: "T3_GATEWAY_API_KEY", value: "test-secret", sensitive: true },
    { name: "T3_GATEWAY_HEADER_0", value: "workspace-secret", sensitive: true },
    { name: "HTTPS_PROXY", value: "http://existing-proxy", sensitive: false },
  ],
});
const input = (protocol: "anthropic" | "responses", action: "test" | "models" = "test") => ({
  instanceId: ProviderInstanceId.make("gateway_test"),
  gateway: gateway(protocol),
  environment: instance(protocol).environment!,
  action,
});
const sse = (...events: unknown[]) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const textEvents = (protocol: "anthropic" | "responses") =>
  protocol === "anthropic"
    ? [
        { type: "content_block_delta", delta: { type: "text_delta", text: "OK" } },
        { type: "message_stop" },
      ]
    : [{ type: "response.output_text.delta", delta: "OK" }, { type: "response.completed" }];
const toolEvents = (protocol: "anthropic" | "responses") =>
  protocol === "anthropic"
    ? [
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", name: "gateway_probe", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"ok":' },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "true}" },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_stop" },
      ]
    : [
        {
          type: "response.output_item.done",
          item: { type: "function_call", name: "gateway_probe", arguments: '{"ok":true}' },
        },
        { type: "response.completed" },
      ];

describe("native gateway runtime", () => {
  it("round-trips the contract and applies Claude headers and aliases without altering native files or the stored envelope", () => {
    const original = instance();
    const before = structuredClone(original);
    expect(decodeInstance(original).gateway).toEqual(original.gateway);
    const projected = projectGatewayInstance(original, {});
    const env = mergeProviderInstanceEnvironment(projected.environment, {
      HOME: "/home/original",
      CLAUDE_CODE_OAUTH_TOKEN: "old-oauth",
      ANTHROPIC_API_KEY: "old-key",
      CLAUDE_CODE_USE_VERTEX: "1",
    });
    expect(env).toMatchObject({
      HOME: "/home/original",
      HTTPS_PROXY: "http://existing-proxy",
      ANTHROPIC_BASE_URL: "https://gateway.example/custom/prefix",
      ANTHROPIC_AUTH_TOKEN: "test-secret",
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      CLAUDE_CODE_USE_VERTEX: "0",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "vendor/small",
      CLAUDE_CODE_SUBAGENT_MODEL: "vendor/model-v2",
      ANTHROPIC_CUSTOM_HEADERS: "X-Workspace: workspace-secret",
    });
    expect(original).toEqual(before);
    expect(projected.config).toMatchObject({ homePath: "/untouched/native-home" });
  });

  it("builds literal Codex Responses overrides while keeping keys out of argv and respecting existing launch arguments", () => {
    const original = instance("responses");
    const projected = projectGatewayInstance(
      {
        ...original,
        gateway: {
          ...original.gateway!,
          baseUrl: "https://gateway.example/a'b",
          model: 'vendor/"special"',
        },
      },
      { T3CODE_CODEX_LAUNCH_ARGS: "--config 'sandbox_mode=\"workspace-write\"'" },
    );
    const env = mergeProviderInstanceEnvironment(projected.environment, {});
    const argv = tokenizeCliArgs(env.T3CODE_CODEX_LAUNCH_ARGS);
    expect(argv).toContain('sandbox_mode="workspace-write"');
    expect(argv).toContain('model_provider="t3_gateway"');
    expect(argv).toContain('model_providers.t3_gateway.wire_api="responses"');
    expect(argv).toContain("model_providers.t3_gateway.requires_openai_auth=false");
    expect(argv).toContain('model_providers.t3_gateway.base_url="https://gateway.example/a\'b"');
    expect(argv).toContain('model="vendor/\\"special\\""');
    expect(argv).toContain('model_providers.t3_gateway.env_key="T3_GATEWAY_API_KEY"');
    expect(argv.join(" ")).not.toContain("test-secret");
    expect(argv.join(" ")).not.toContain("workspace-secret");
    expect(env.HTTPS_PROXY).toBe("http://existing-proxy");
  });

  it("supports native x-api-key for both agents", () => {
    for (const protocol of ["anthropic", "responses"] as const) {
      const original = instance(protocol);
      const projected = projectGatewayInstance(
        { ...original, gateway: { ...original.gateway!, auth: "api-key" } },
        {},
      );
      const env = mergeProviderInstanceEnvironment(projected.environment, {});
      expect(
        gatewayHeaders({ ...original.gateway!, auth: "api-key" }, original.environment!),
      ).toEqual({ "x-api-key": "test-secret", "X-Workspace": "workspace-secret" });
      if (protocol === "anthropic")
        expect(env).toMatchObject({ ANTHROPIC_API_KEY: "test-secret", ANTHROPIC_AUTH_TOKEN: "" });
      else
        expect(tokenizeCliArgs(env.T3CODE_CODEX_LAUNCH_ARGS)).toContain(
          'model_providers.t3_gateway.env_http_headers."x-api-key"="T3_GATEWAY_API_KEY"',
        );
    }
  });

  it("can disable or remove a gateway without losing original settings or proxy variables", () => {
    const original = instance();
    const disabled = { ...original, gateway: { ...original.gateway!, enabled: false } };
    expect(projectGatewayInstance(disabled)).toBe(disabled);
    const removed = withoutGateway(original);
    expect(removed.gateway).toBeUndefined();
    expect(removed.config).toEqual(original.config);
    expect(removed.environment).toEqual([
      { name: "HTTPS_PROXY", value: "http://existing-proxy", sensitive: false },
    ]);
    expect(projectGatewayInstance(removed)).toBe(removed);
  });

  it.each([
    "ftp://example.com",
    "https://key@example.com",
    "https://example.com?key=secret",
    "not-a-url",
  ])("rejects invalid or credential-bearing URL %s", (baseUrl) => {
    expect(() =>
      projectGatewayInstance({ ...instance(), gateway: { ...gateway(), baseUrl } }),
    ).toThrow();
  });
  it("rejects incompatible protocol, managed Codex, unsupported driver and reserved header overrides", () => {
    expect(() => projectGatewayInstance({ ...instance(), gateway: gateway("responses") })).toThrow(
      /native protocol/,
    );
    expect(() =>
      projectGatewayInstance({ ...instance("responses"), config: { setupMode: "managed" } }),
    ).toThrow(/local Codex/);
    expect(() =>
      projectGatewayInstance({ ...instance(), driver: ProviderDriverKind.make("grok") }),
    ).toThrow(/support/);
    expect(() =>
      projectGatewayInstance({
        ...instance(),
        gateway: {
          ...gateway(),
          headers: [{ name: "Authorization", variable: "T3_GATEWAY_HEADER_0" }],
        },
      }),
    ).toThrow(/Header names/);
  });

  it("replaces subscription metadata and exposes only the gateway's configured models", () => {
    const snapshot = gatewaySnapshot(instance(), {
      instanceId: ProviderInstanceId.make("test"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      enabled: true,
      installed: true,
      version: "2.0.0",
      status: "ready",
      checkedAt: "2026-10-31T00:00:00Z",
      auth: { status: "authenticated", email: "old@example.com", type: "subscription" },
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: { checkedAt: "2026-10-31T00:00:00Z", windows: [] },
    });
    expect(snapshot.auth).toEqual({
      status: "unknown",
      type: "apiKey",
      label: "Custom API gateway",
    });
    expect(snapshot.usageLimits).toBeUndefined();
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "vendor/model-v2",
      "vendor/second",
      "vendor/small",
    ]);
    expect(snapshot.setup?.canAuthenticate).toBe(false);
  });

  it("keeps gateway catalogs authoritative through registry merging, wire decoding and restart caches", () => {
    const native: ServerProvider = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: "2.0.0",
      status: "ready",
      checkedAt: "2026-10-31T00:00:00Z",
      auth: { status: "authenticated", type: "subscription" },
      models: ["claude-opus-5-5", "vendor/model-v2"].map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select" as const,
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      })),
      slashCommands: [],
      skills: [],
    };
    const gateway = gatewaySnapshot(instance(), native);
    const merged = decodeProviderSnapshot(JSON.stringify(mergeProviderSnapshot(native, gateway)));
    expect(merged.modelCatalogSource).toBe("gateway");
    expect(merged.models).toEqual(gateway.models);
    expect(merged.models.every((model) => model.capabilities === null)).toBe(true);
    expect(hydrateCachedProvider({ cachedProvider: native, fallbackProvider: gateway })).toEqual(
      gateway,
    );
    expect(hydrateCachedProvider({ cachedProvider: gateway, fallbackProvider: native })).toEqual(
      native,
    );
    expect(mergeProviderSnapshot(merged, native).models).toEqual(native.models);
    expect(mergeProviderSnapshot(merged, native).modelCatalogSource).toBeUndefined();
  });

  it.effect(
    "uses private temporary Claude settings so user/project env cannot override the gateway",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* Effect.scoped(
          Effect.gen(function* () {
            const projected = projectGatewayInstance(instance(), {});
            const env = mergeProviderInstanceEnvironment(projected.environment, {});
            const writer = yield* makeClaudeGatewaySettingsWriter(env);
            const result = yield* writer({
              env: { ANTHROPIC_BASE_URL: "https://old.invalid", KEEP_THIS: "yes" },
              alwaysThinkingEnabled: false,
            });
            if (typeof result !== "string") throw new Error("Expected a private settings file");
            expect((yield* fs.stat(result)).mode & 0o777).toBe(0o600);
            const stored = decodeSessionSettings(yield* fs.readFileString(result));
            expect(stored.env).toMatchObject({
              ANTHROPIC_BASE_URL: "https://gateway.example/custom/prefix",
              ANTHROPIC_AUTH_TOKEN: "test-secret",
              KEEP_THIS: "yes",
            });
            expect(stored.alwaysThinkingEnabled).toBe(false);
            return result;
          }),
        );
        expect(yield* fs.exists(file)).toBe(false);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("gateway credentials and editor", () => {
  it("preserves redacted credentials when editing a URL, and makes every new header sensitive", () => {
    const id = ProviderInstanceId.make("gateway_test");
    const redacted = redactServerSettingsForClient({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [id]: instance() },
    }).providerInstances[id]!;
    expect(JSON.stringify(redacted)).not.toContain("test-secret");
    const next = {
      ...redacted,
      gateway: { ...redacted.gateway!, baseUrl: "https://new.example/api" },
    };
    expect(next.environment?.find((row) => row.name === "T3_GATEWAY_API_KEY")?.valueRedacted).toBe(
      true,
    );
    expect(resolveGatewaySecrets(next.environment!, instance().environment!)).toMatchObject([
      { name: "T3_GATEWAY_API_KEY", value: "test-secret" },
      { name: "T3_GATEWAY_HEADER_0", value: "workspace-secret" },
    ]);
    expect(() => resolveGatewaySecrets(next.environment!, [])).toThrow(/unavailable/);
  });
});

describe.each(["anthropic", "responses"] as const)("%s native gateway probe", (protocol) => {
  it("sends the exact native URL, key, model and streaming/tool payloads", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const request: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init: init! });
      const body = JSON.parse(String(init?.body));
      return new Response(sse(...(body.tools ? toolEvents(protocol) : textEvents(protocol))), {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const result = await probeGateway(input(protocol), new AbortController().signal, request);
    expect(result.checks.map((check) => check.ok)).toEqual([true, true]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(
      `https://gateway.example/custom/prefix${protocol === "anthropic" ? "/v1/messages" : "/responses"}`,
    );
    expect(calls[0]!.init).toMatchObject({
      redirect: "error",
      method: "POST",
      headers: { Authorization: "Bearer test-secret", "X-Workspace": "workspace-secret" },
    });
    expect(JSON.parse(String(calls[1]!.init.body))).toMatchObject({
      model: "vendor/model-v2",
      stream: true,
      tools: [expect.objectContaining({ name: "gateway_probe" })],
    });
  });

  it("loads model IDs without requiring a successful inference request", async () => {
    const urls: string[] = [];
    const result = await probeGateway(
      input(protocol, "models"),
      new AbortController().signal,
      async (url) => {
        urls.push(String(url));
        return Response.json({
          data: [{ id: "a" }, { id: "a" }, { id: "b" }, { unrelated: true }],
        });
      },
    );
    expect(result.models).toEqual(["a", "b"]);
    expect(urls).toEqual([
      `https://gateway.example/custom/prefix${protocol === "anthropic" ? "/v1" : ""}/models`,
    ]);
  });

  it("rejects HTTP success with the wrong protocol, incomplete streams, malformed tool calls and secret-bearing errors", async () => {
    expect(inspectGatewayStream(sse(...textEvents(protocol).slice(0, 1)), protocol, false)).toMatch(
      /completion event/,
    );
    expect(inspectGatewayStream(sse(...textEvents(protocol)), protocol, true)).toMatch(/tool call/);
    expect(
      inspectGatewayStream(
        sse(...textEvents(protocol === "anthropic" ? "responses" : "anthropic")),
        protocol,
        false,
      ),
    ).toMatch(/completion event/);
    expect(inspectGatewayStream("data: broken\n\n", protocol, false)).toMatch(/malformed/);
    const result = await probeGateway(input(protocol), new AbortController().signal, async () =>
      Response.json({ error: "test-secret workspace-secret" }, { status: 401 }),
    );
    expect(result.checks.every((check) => !check.ok && check.detail.includes("HTTP 401"))).toBe(
      true,
    );
    expect(JSON.stringify(result)).not.toContain("test-secret");
  });

  it("accepts native SSE split across network chunks", async () => {
    const request: typeof fetch = async (_, init) => {
      const events = JSON.parse(String(init?.body)).tools
        ? toolEvents(protocol)
        : textEvents(protocol);
      const bytes = new TextEncoder().encode(sse(...events).replace(/\n/g, "\r\n"));
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    expect(
      (await probeGateway(input(protocol), new AbortController().signal, request)).checks.every(
        (check) => check.ok,
      ),
    ).toBe(true);
  });
});

it("uses the selected server's HTTP connection and refuses credential-bearing redirects", async () => {
  let redirectedRequests = 0;
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    if (request.url === "/redirect/models") {
      response.writeHead(307, { location: "/credential-leak" });
      response.end();
      return;
    }
    if (request.url === "/credential-leak") redirectedRequests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const target = input("responses", "models");
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    const success = await probeGateway(
      { ...target, gateway: { ...target.gateway, baseUrl } },
      new AbortController().signal,
    );
    expect(success.models).toEqual(["local-model"]);
    expect(requests[0]).toEqual({ path: "/api/models", authorization: "Bearer test-secret" });
    const redirect = await probeGateway(
      {
        ...target,
        gateway: { ...target.gateway, baseUrl: `http://127.0.0.1:${address.port}/redirect` },
      },
      new AbortController().signal,
    );
    expect(redirect.checks[0]?.ok).toBe(false);
    expect(redirectedRequests).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
