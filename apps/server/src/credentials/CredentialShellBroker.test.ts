// @effect-diagnostics nodeBuiltinImport:off - Exercise the real local transport used by native shells.
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Config from "../config.ts";
import * as Store from "../auth/ServerSecretStore.ts";
import * as Vault from "./CredentialVault.ts";
import * as Broker from "./CredentialShellBroker.ts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { disposeMcpSession, registerProviderCredentialSocket } from "../mcp/McpProviderSession.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { publishCredentialSession, publishToolBindings } from "./CredentialBridgeState.ts";
import { ToolBindings } from "./ToolBindings.ts";
import * as SubscriptionRef from "effect/SubscriptionRef";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("broker-test"),
  threadId: ThreadId.make("broker-thread"),
  providerSessionId: "broker-session",
  providerInstanceId: ProviderInstanceId.make("grok"),
  capabilities: new Set(),
  issuedAt: 1,
  allowedFileRoots: ["/fixture-project"],
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const request = (path: string, authorization: string) =>
  Effect.tryPromise(
    () =>
      new Promise<unknown>((resolve, reject) => {
        const socket = NodeNet.connect(path);
        let text = "";
        socket.once("connect", () => socket.write(encode({ authorization }) + "\n"));
        socket.on("data", (data) => {
          text += data;
        });
        socket.once("error", reject);
        socket.once("end", () => {
          try {
            resolve(decode(text));
          } catch (error) {
            reject(error);
          }
        });
      }),
  );
it.effect(
  "injects granted values only for the live session, shares one socket, and honors revocation",
  () =>
    Effect.gen(function* () {
      let alive = true;
      const registry = Layer.mock(McpSessionRegistry)({
        resolveCredential: (token) =>
          Effect.succeed(alive && token === "fixture-broker-token" ? scope : undefined),
      });
      const services = Broker.layer.pipe(
        Layer.provide(registry),
        Layer.provideMerge(Vault.layer),
        Layer.provide(Store.layer),
        Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-broker-test-" })),
        Layer.provideMerge(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-socket-" });
        const broker = yield* Broker.CredentialShellBroker;
        const vault = yield* Vault.CredentialVault;
        const paths = yield* Effect.all([broker.open(directory), broker.open(directory)], {
          concurrency: "unbounded",
        });
        expect(paths[0]).toBe(paths[1]);
        expect((yield* fs.stat(paths[0])).mode & 0o777).toBe(0o600);
        const unregister = registerProviderCredentialSocket(scope.providerInstanceId, paths[0]);
        try {
          yield* vault.write({
            name: "APP_KEY",
            description: "",
            valueType: "token",
            value: Redacted.make("fixture-broker-key"),
            allowedInstances: [scope.providerInstanceId],
          });
          yield* Effect.promise(() =>
            publishCredentialSession(scope, "Bearer fixture-broker-token"),
          );
          expect(yield* request(paths[0], "Bearer fixture-broker-token")).toEqual({
            ok: true,
            environment: {},
          });
          expect(yield* request(paths[0], "Bearer invalid")).toEqual({ ok: false });
          const grant = yield* vault.requestUse(scope, ["APP_KEY"], "Native curl test");
          const digest = NodeCrypto.createHash("sha256")
            .update("Bearer fixture-broker-token")
            .digest("hex");
          const file = `${paths[0]}.${digest}.grant`;
          const encrypted = yield* fs.readFile(file);
          expect(Buffer.from(encrypted).toString()).not.toContain("fixture-broker-key");
          const key = NodeCrypto.createHash("sha256")
            .update("t3-credential-bridge-v1\0Bearer fixture-broker-token")
            .digest();
          const decipher = NodeCrypto.createDecipheriv(
            "aes-256-gcm",
            key,
            encrypted.subarray(0, 12),
          );
          decipher.setAAD(Buffer.from("t3-credential-bridge-v1"));
          decipher.setAuthTag(Buffer.from(encrypted.subarray(-16)));
          const grantData = decode(
            Buffer.concat([
              decipher.update(encrypted.subarray(12, -16)),
              decipher.final(),
            ]).toString(),
          );
          expect(grantData).toEqual({
            grants: [
              { environment: { APP_KEY: "fixture-broker-key" }, expiresAt: grant.expiresAt },
            ],
          });
          expect(yield* request(paths[0], "Bearer fixture-broker-token")).toEqual({
            ok: true,
            environment: { APP_KEY: "fixture-broker-key" },
          });
          yield* vault.revokeUse(scope, grant.id);
          expect(yield* request(paths[0], "Bearer fixture-broker-token")).toEqual({
            ok: true,
            environment: {},
          });
          alive = false;
          yield* Effect.promise(() => disposeMcpSession(scope.providerSessionId));
          expect(yield* fs.exists(file)).toBe(false);
          expect(yield* request(paths[0], "Bearer fixture-broker-token")).toEqual({ ok: false });
        } finally {
          unregister();
        }
      }).pipe(Effect.provide(services), Effect.scoped);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.effect(
  "keeps gh out of ordinary shells and synchronously replaces native fallback files on binding/vault revocation",
  () => {
    const registry = Layer.mock(McpSessionRegistry)({
      resolveCredential: (token) =>
        Effect.succeed(token === "fixture-broker-token" ? scope : undefined),
    });
    const tools = Layer.effect(
      ToolBindings,
      Effect.gen(function* () {
        const vault = yield* Vault.CredentialVault;
        const revision = yield* SubscriptionRef.make(0);
        let enabled = true;
        return ToolBindings.of({
          revision,
          snapshot: Effect.succeed([]),
          write: () => Effect.void,
          action: () =>
            Effect.sync(() => {
              enabled = false;
            }).pipe(Effect.andThen(Effect.promise(publishToolBindings))),
          gh: (instanceId) =>
            enabled
              ? vault.resolveBinding(instanceId, ["APP_KEY"]).pipe(
                  Effect.map(({ values }) => ({
                    environment: { GH_TOKEN: values.APP_KEY!, GH_HOST: "github.com" },
                    expiresAt: Date.now() + 60 * 60_000,
                  })),
                )
              : Effect.succeed(undefined),
        });
      }),
    );
    const services = Broker.layer.pipe(
      Layer.provide(registry),
      Layer.provideMerge(tools),
      Layer.provideMerge(Vault.layer),
      Layer.provide(Store.layer),
      Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-tool-file-test-" })),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-tool-file-" });
      const broker = yield* Broker.CredentialShellBroker;
      const vault = yield* Vault.CredentialVault;
      const address = yield* broker.open(directory);
      const unregister = registerProviderCredentialSocket(scope.providerInstanceId, address);
      const authorization = "Bearer fixture-broker-token";
      const file =
        address +
        "." +
        NodeCrypto.createHash("sha256").update(authorization).digest("hex") +
        ".grant";
      const text = Effect.gen(function* () {
        const data = yield* fs.readFile(file);
        const key = NodeCrypto.createHash("sha256")
          .update("t3-credential-bridge-v1\0" + authorization)
          .digest();
        const cipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
        cipher.setAAD(Buffer.from("t3-credential-bridge-v1"));
        cipher.setAuthTag(Buffer.from(data.subarray(-16)));
        return Buffer.concat([cipher.update(data.subarray(12, -16)), cipher.final()]).toString();
      });
      try {
        const input = {
          name: "APP_KEY",
          description: "",
          valueType: "token" as const,
          value: Redacted.make("fixture-gh-only"),
          allowedInstances: [scope.providerInstanceId],
        };
        yield* vault.write(input);
        yield* Effect.promise(() => publishCredentialSession(scope, authorization));
        expect(yield* request(address, authorization)).toEqual({ ok: true, environment: {} });
        expect(yield* text).toContain("fixture-gh-only");
        // The vault lock used to publish grants is now exercised with an active
        // tool binding: a reversed lock order would never reach these receipts.
        yield* vault.write({ ...input, allowedInstances: [] });
        expect(yield* text).not.toContain("fixture-gh-only");
        yield* vault.write(input);
        expect(yield* text).toContain("fixture-gh-only");
        yield* (yield* ToolBindings).action({
          instanceId: scope.providerInstanceId,
          action: "delete",
        });
        expect(yield* text).not.toContain("fixture-gh-only");
      } finally {
        unregister();
        yield* Effect.promise(() => disposeMcpSession(scope.providerSessionId));
      }
    }).pipe(Effect.provide(services), Effect.scoped);
  },
);
