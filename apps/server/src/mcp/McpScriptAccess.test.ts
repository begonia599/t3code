import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";
import * as Config from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Vault from "../credentials/CredentialVault.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HostedMcp, layer as hostedLayer } from "./HostedMcp.ts";
import { McpScriptAccess, layer as scriptsLayer } from "./McpScriptAccess.ts";
import { McpSessionRegistry, __testing } from "./McpSessionRegistry.ts";
import {
  registerProviderCredentialSocket,
  registerProviderFileRoots,
} from "./McpProviderSession.ts";

const dependencies = scriptsLayer.pipe(
  Layer.provideMerge(hostedLayer),
  Layer.provideMerge(Layer.effect(McpSessionRegistry, __testing.make())),
  Layer.provideMerge(Vault.layer),
  Layer.provideMerge(SecretStore.layer),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-script-access-test-" })),
  Layer.provide(
    Layer.succeed(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
      serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
    }),
  ),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("script-test")),
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "writes private, restricted script contexts and removes them on revoke or parent shutdown",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-script-bridge-" });
      const id = ProviderInstanceId.make("script-test-instance");
      const unregisterRoots = registerProviderFileRoots(id, [directory]);
      const unregisterSocket = registerProviderCredentialSocket(
        id,
        `${directory}/socket`,
        "10.233.0.5",
      );
      try {
        const hosted = yield* HostedMcp;
        const scripts = yield* McpScriptAccess;
        const registry = yield* McpSessionRegistry;
        yield* hosted.write({
          id: "fixture",
          label: "Fixture",
          enabled: true,
          allowedInstances: [id],
          exposure: { allowedTools: ["identity"] },
          transport: { type: "stdio", command: "/usr/bin/true", args: [], environment: {} },
        });
        const issued = yield* registry.issue({
          providerInstanceId: id,
          threadId: ThreadId.make("script-test-thread"),
          capabilities: new Set(),
        });
        const scope = (yield* registry.resolve(issued.config.authorizationHeader.slice(7)))!;
        expect(
          (yield* scripts
            .request(scope, { service: "fixture", tools: ["unapproved"], purpose: "test" })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const request = { service: "fixture", tools: ["identity"], purpose: "batch test" };
        const access = yield* scripts.request(scope, request);
        expect(JSON.stringify(access)).not.toContain("Bearer");
        expect((yield* fs.stat(access.contextFile)).mode & 0o777).toBe(0o600);
        const context = JSON.parse(yield* fs.readFileString(access.contextFile)) as {
          authorization: string;
          endpoint: string;
        };
        expect(context.endpoint).toBe("http://10.233.0.5:43123/mcp/hosted/fixture");
        const token = context.authorization.slice(7);
        expect(yield* registry.resolve(token)).toBeUndefined();
        expect(yield* registry.resolveHosted(token, "other")).toBeUndefined();
        expect(
          (yield* registry.resolveHosted(token, "fixture"))?.script?.tools.has("identity"),
        ).toBe(true);
        expect(
          yield* scripts.revoke({ ...scope, providerSessionId: "another-session" }, access.id),
        ).toBe(false);
        expect(yield* scripts.revoke(scope, access.id)).toBe(true);
        expect(yield* fs.exists(access.contextFile)).toBe(false);
        const next = yield* scripts.request(scope, request);
        yield* registry.revokeProviderSession(scope.providerSessionId);
        expect(yield* fs.exists(next.contextFile)).toBe(false);
      } finally {
        unregisterSocket();
        unregisterRoots();
      }
    }).pipe(Effect.provide(dependencies), Effect.scoped),
);
