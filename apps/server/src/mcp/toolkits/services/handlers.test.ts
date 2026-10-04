import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { ServicesToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { ServiceNetwork } from "../../../services/ServiceNetwork.ts";

it.effect(
  "MCP callers cannot replace their authenticated publishing identity in tool arguments",
  () => {
    const codex = ProviderInstanceId.make("codex-main");
    const requests: Array<string> = [];
    const network = Layer.succeed(
      ServiceNetwork,
      ServiceNetwork.of({
        request: (instanceId) => {
          requests.push(instanceId);
          return Effect.succeed({
            instanceId,
            privateIp: "10.233.0.6",
            instances: [],
            publications: [],
            shares: [],
          });
        },
      }),
    );
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      clientCapabilities: {},
      clientInfo: { name: "services-test", version: "1" },
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "services-test", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const response = yield* server.callTool({
        name: "service_publish",
        arguments: {
          name: "blog",
          port: 3000,
          hostname: "blog.example.com",
          instanceId: "grok-main",
          upstream: "127.0.0.1:2019",
        },
      });
      expect(response.isError).toBeFalsy();
      expect(requests).toEqual([codex]);
      expect(response.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('"instanceId":"codex-main"'),
          }),
        ]),
      );
    }).pipe(
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("services-test"),
        threadId: ThreadId.make("services-thread"),
        providerSessionId: "services-session",
        providerInstanceId: codex,
        capabilities: new Set<McpCapability>(),
        issuedAt: 1,
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(
        ServicesToolkitRegistrationLive.pipe(
          Layer.provide(network),
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    );
  },
);
