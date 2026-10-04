import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import { CredentialVault, make } from "./CredentialVault.ts";
import * as Vault from "./CredentialVault.ts";
import { registerProviderCredentialSocket } from "../mcp/McpProviderSession.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { observeCredentialGrants } from "./CredentialBridgeState.ts";

export const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("vault-test"),
  threadId: ThreadId.make("vault-thread"),
  providerSessionId: "session-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
  allowedFileRoots: ["/projects"],
};
const layer = Vault.layer.pipe(
  Layer.provideMerge(SecretStore.layer),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-vault-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const input = {
  name: "OPENAI_API_KEY",
  description: "Application key",
  valueType: "token" as const,
  value: Redacted.make("fixture-private-openai-key"),
  allowedInstances: [scope.providerInstanceId],
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect(
  "older clients cannot silently remove a binding-only credential's usage restriction",
  () =>
    Effect.gen(function* () {
      const vault = yield* CredentialVault;
      yield* vault.write({ ...input, usage: "bindings-only" });
      yield* vault.write({ ...input, description: "Updated by an older client" });
      expect((yield* vault.snapshot).credentials[0]?.usage).toBe("bindings-only");
    }).pipe(Effect.provide(layer)),
);

it.effect("continues a pending native input call with metadata after private submission", () =>
  Effect.gen(function* () {
    const vault = yield* CredentialVault;
    const call = yield* vault
      .requestInputAndWait(scope, {
        name: input.name,
        description: input.description,
        valueType: input.valueType,
        purpose: "Application model query",
      })
      .pipe(Effect.forkScoped);
    const published = yield* Stream.runHead(
      SubscriptionRef.changes(vault.revision).pipe(
        Stream.mapEffect(() => vault.snapshot),
        Stream.filter((snapshot) => snapshot.requests.length > 0),
      ),
    );
    expect(Option.isSome(published)).toBe(true);
    if (Option.isNone(published)) return;
    const request = published.value.requests[0]!;
    yield* vault.write({ ...input, requestId: request.id });
    const result = yield* Fiber.join(call);
    expect(result.status).toBe("configured");
    expect(result.credential?.name).toBe(input.name);
    expect(encode(result)).not.toContain("fixture-private-openai-key");
    expect((yield* vault.snapshot).requests).toEqual([]);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("resolves dismissed and expired input calls and removes cancelled forms", () =>
  Effect.gen(function* () {
    const vault = yield* CredentialVault;
    for (const status of ["dismissed", "expired", "cancelled"] as const) {
      const call = yield* vault
        .requestInputAndWait(scope, {
          name: input.name,
          description: "",
          valueType: input.valueType,
          purpose: status,
        })
        .pipe(Effect.forkScoped);
      const published = yield* Stream.runHead(
        SubscriptionRef.changes(vault.revision).pipe(
          Stream.mapEffect(() => vault.snapshot),
          Stream.filter((snapshot) => snapshot.requests.length > 0),
        ),
      );
      if (Option.isNone(published)) return;
      const request = published.value.requests[0]!;
      if (status === "dismissed") yield* vault.action({ action: "dismiss", id: request.id });
      else if (status === "expired") yield* TestClock.adjust("15 minutes");
      else yield* Fiber.interrupt(call);
      if (status !== "cancelled") expect((yield* Fiber.join(call)).status).toBe(status);
      expect((yield* vault.snapshot).requests).toEqual([]);
    }
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("does not leave a usable grant after the native transport rejects publication", () =>
  Effect.gen(function* () {
    const vault = yield* CredentialVault;
    const unregister = registerProviderCredentialSocket(scope.providerInstanceId, "/fixture.sock");
    let publishedCount = -1;
    const stop = observeCredentialGrants(async (grants) => {
      publishedCount = grants.length;
      if (grants.length > 0) throw new Error("Fixture bridge write failure");
    });
    try {
      yield* vault.write(input);
      expect(
        (yield* vault.requestUse(scope, [input.name], "Failed transport").pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* vault.shellEnvironment(scope)).toEqual({});
      expect((yield* vault.snapshot).grants).toEqual([]);
      expect(publishedCount).toBe(0);
    } finally {
      stop();
      unregister();
    }
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "persists encrypted values, exposes only metadata, and survives a restart without grants",
  () =>
    Effect.gen(function* () {
      const vault = yield* CredentialVault;
      const metadata = yield* vault.write(input);
      expect(encode(metadata)).not.toContain("fixture-private-openai-key");
      expect(metadata.credentials[0]).toMatchObject({
        length: 26,
        allowedInstances: [scope.providerInstanceId],
      });
      const store = yield* ServerSecretStore;
      const bytes = yield* store.get("credential-vault");
      expect(Option.isSome(bytes)).toBe(true);
      if (Option.isSome(bytes))
        expect(Buffer.from(bytes.value).toString()).not.toContain("fixture-private-openai-key");
      const restarted = yield* make;
      expect((yield* restarted.snapshot).credentials).toEqual(metadata.credentials);
      expect(yield* restarted.shellEnvironment(scope)).toEqual({});
      expect(
        yield* restarted.list({
          ...scope,
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        }),
      ).toEqual([]);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "binds grants to a session and instance, expires them, and supports revoke and value replacement",
  () =>
    Effect.gen(function* () {
      const vault = yield* CredentialVault;
      const unregister = registerProviderCredentialSocket(
        scope.providerInstanceId,
        "/fixture.sock",
      );
      try {
        yield* vault.write(input);
        const grant = yield* vault.requestUse(
          scope,
          [input.name],
          "List available application models",
        );
        expect(yield* vault.shellEnvironment(scope)).toEqual({
          OPENAI_API_KEY: "fixture-private-openai-key",
        });
        expect(yield* vault.shellEnvironment({ ...scope, providerSessionId: "session-b" })).toEqual(
          {},
        );
        expect(yield* vault.revokeUse({ ...scope, providerSessionId: "session-b" }, grant.id)).toBe(
          false,
        );
        expect(yield* vault.revokeUse(scope, grant.id)).toBe(true);
        expect(yield* vault.shellEnvironment(scope)).toEqual({});
        yield* vault.requestUse(scope, [input.name], "Test expiration");
        yield* TestClock.adjust("16 minutes");
        expect(yield* vault.shellEnvironment(scope)).toEqual({});
        yield* vault.requestUse(scope, [input.name], "Test replacement");
        yield* vault.write({ ...input, value: Redacted.make("replacement-fixture") });
        expect(yield* vault.shellEnvironment(scope)).toEqual({});
        expect(
          (yield* vault
            .requestUse(
              { ...scope, providerInstanceId: ProviderInstanceId.make("grok") },
              [input.name],
              "denied",
            )
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        yield* vault.action({ action: "delete", name: input.name });
        expect(yield* vault.list(scope)).toEqual([]);
      } finally {
        unregister();
      }
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect(
  "private input templates require the requested name and instance and can be dismissed",
  () =>
    Effect.gen(function* () {
      const vault = yield* CredentialVault;
      const request = yield* vault.requestInput(scope, {
        name: input.name,
        description: input.description,
        valueType: "token",
        purpose: "Application model query",
      });
      expect(
        (yield* vault.requestInput(scope, {
          name: input.name,
          description: "duplicate",
          valueType: "token",
          purpose: "same",
        })).id,
      ).toBe(request.id);
      expect(
        (yield* vault
          .write({ ...input, requestId: request.id, allowedInstances: [] })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* vault.write({ ...input, requestId: request.id });
      expect((yield* vault.snapshot).requests).toEqual([]);
      yield* vault.write({
        name: input.name,
        description: "Edited metadata",
        valueType: "text",
        allowedInstances: input.allowedInstances,
      });
      expect((yield* vault.mcpEnvironment(scope, [input.name]))[input.name]).toBe(
        "fixture-private-openai-key",
      );
      const other = yield* vault.requestInput(scope, {
        name: "NAI_TOKEN",
        description: "",
        valueType: "token",
        purpose: "Generate an image",
      });
      yield* vault.action({ action: "dismiss", id: other.id });
      expect((yield* vault.snapshot).requests).toEqual([]);
      const expired = yield* vault.requestInput(scope, {
        name: input.name,
        description: "",
        valueType: "token",
        purpose: "Expired private input",
      });
      yield* TestClock.adjust("61 minutes");
      expect((yield* vault.snapshot).requests).toEqual([]);
      expect(
        (yield* vault.write({ ...input, requestId: expired.id }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      for (const name of ["HOME", "BASH_ENV", "LD_PRELOAD", "T3_CREDENTIAL_SOCKET"])
        expect((yield* vault.write({ ...input, name }).pipe(Effect.result))._tag).toBe("Failure");
    }).pipe(Effect.provide(layer), Effect.scoped),
);
