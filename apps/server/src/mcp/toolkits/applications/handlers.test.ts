import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { Applications, type ApplicationScope } from "../../../services/Applications.ts";
import { ToolBindings } from "../../../credentials/ToolBindings.ts";
import { ApplicationsToolkit } from "./tools.ts";
import { ApplicationsToolkitHandlersLive } from "./handlers.ts";

it.effect(
  "registers the complete native MCP toolkit and preserves authenticated instance and workspace scope",
  () => {
    const requests: Array<ApplicationScope> = [];
    const instance = ProviderInstanceId.make("codex");
    const apps = Layer.succeed(Applications, {
      deploymentAdmin: () => Effect.die("unused"),
      request: (scope) =>
        Effect.sync(() => {
          requests.push(scope);
          return { applications: [] };
        }),
      environment: (scope) =>
        Effect.succeed({
          instanceId: scope.providerInstanceId,
          home: "/projects",
          workspaces: ["/projects/blog"],
          executionUid: 1234,
          applicationBackend: "docker-compose",
          applicationRuntimeUid: 1003,
          applicationLifecycle: "independent",
          harnessLifecycle: "session",
          frameworkAccess: "read-only",
          networkNamespace: "codex",
          publicAccess: "Caddy",
          privateApplicationAccess: "tools",
        }),
    });
    const bindings = Layer.effect(
      ToolBindings,
      Effect.gen(function* () {
        return ToolBindings.of({
          revision: yield* SubscriptionRef.make(0),
          snapshot: Effect.succeed([]),
          write: () => Effect.void,
          action: () => Effect.void,
          gh: () => Effect.succeed(undefined),
        });
      }),
    );
    const client = McpSchema.McpServerClient.of({
      clientId: 1,
      clientCapabilities: {},
      clientInfo: { name: "applications-test", version: "1" },
      protocolVersion: "2025-06-18",
      initializePayload: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "applications-test", version: "1" },
      },
      getClient: Effect.die("unused"),
    });
    return Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const info = yield* server.callTool({ name: "environment_info", arguments: {} });
      expect(info.isError).toBeFalsy();
      expect(JSON.stringify(info.content)).toContain("docker-compose");
      const result = yield* server.callTool({
        name: "application_list",
        arguments: {
          providerInstanceId: "grok",
          allowedFileRoots: ["/"],
        },
      });
      expect(result.isError).toBeFalsy();
      expect(
        requests.map((request) => ({
          instanceId: request.providerInstanceId,
          roots: request.allowedFileRoots,
        })),
      ).toEqual([{ instanceId: instance, roots: ["/projects/blog"] }]);
      const draft = yield* server.callTool({
        name: "application_request_deployment",
        arguments: {
          profileId: "bot",
          applicationName: "bot",
          projectRoot: "/projects/blog",
          runtimeIdentity: "root",
          network: "instance",
          listenPorts: [],
          build: { memoryMiB: 1024, cpuPercent: 100, tasks: 128, timeoutSeconds: 900 },
          runtime: { memoryMiB: 256, cpuPercent: 50, tasks: 64, timeoutSeconds: 60 },
          providerInstanceId: "grok",
          allowedFileRoots: ["/"],
        },
      });
      expect(draft.isError).toBeFalsy();
      expect(requests.at(-1)).toMatchObject({
        providerInstanceId: instance,
        allowedFileRoots: ["/projects/blog"],
      });
      const approval = yield* server
        .callTool({ name: "application_approve_deployment", arguments: {} })
        .pipe(Effect.result);
      expect(approval._tag).toBe("Failure");
    }).pipe(
      Effect.provideService(McpInvocationContext, {
        environmentId: EnvironmentId.make("applications-test"),
        threadId: ThreadId.make("app-test-thread"),
        providerSessionId: "fixture",
        providerInstanceId: instance,
        capabilities: new Set<McpCapability>(),
        issuedAt: 1,
        allowedFileRoots: ["/projects/blog"],
      }),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(
        McpServer.toolkit(ApplicationsToolkit).pipe(
          Layer.provide(ApplicationsToolkitHandlersLive),
          Layer.provide(apps),
          Layer.provide(bindings),
          Layer.provideMerge(McpServer.McpServer.layer),
        ),
      ),
    );
  },
);
