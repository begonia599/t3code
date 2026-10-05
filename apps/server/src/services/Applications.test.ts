import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ApplicationRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Vault from "../credentials/CredentialVault.ts";
import { CredentialVault } from "../credentials/CredentialVault.ts";
import * as Store from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import { ApplicationBroker, Applications, make } from "./Applications.ts";

const scope = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  allowedFileRoots: ["/projects/blog"],
};
const applicationId = "a".repeat(32);
const releaseId = "b".repeat(32);
const operationId = "c".repeat(32);
const timestamp = "2026-10-02T00:00:00+00:00";
const prepared = {
  application: {
    id: applicationId,
    name: "blog",
    projectRoot: "/projects/blog",
    createdBy: "codex",
    createdAt: timestamp,
    updatedAt: timestamp,
    state: "unpublished",
  },
  release: {
    id: releaseId,
    applicationId,
    createdAt: timestamp,
    createdBy: "codex",
    snapshotDigest: "digest",
    manifestPath: "compose.yaml",
    credentialNames: ["APP_KEY"],
    credentialVersions: {},
    ports: [],
    hostname: null,
    endpoint: null,
    composeProject: "fixture",
    status: "prepared",
    components: ["web"],
    images: {},
    sourceCommit: null,
  },
  operation: {
    id: operationId,
    applicationId,
    releaseId,
    actor: "codex",
    action: "publish",
    stage: "validating",
    createdAt: timestamp,
    updatedAt: timestamp,
  },
};
function fixture(backend: "docker-compose" | "systemd" = "docker-compose") {
  const response =
    backend === "systemd"
      ? {
          ...prepared,
          application: { ...prepared.application, backend, deploymentProfile: "bot" },
          release: {
            ...prepared.release,
            backend,
            manifestPath: "application.yaml",
            runtimeUser: "root",
            deploymentProfile: "bot",
          },
        }
      : prepared;
  if (backend === "systemd") Reflect.deleteProperty(response.release, "composeProject");
  let versions: Readonly<Record<string, number>> = {};
  const calls: Array<{
    scope: unknown;
    action: string;
    input: unknown;
    credentials: unknown;
    administrator: boolean | undefined;
  }> = [];
  const broker = Layer.succeed(ApplicationBroker, {
    request: (caller, action, input, credentials, administrator) =>
      Effect.sync(() => {
        calls.push({ scope: caller, action, input, credentials, administrator });
        return action === "inspect"
          ? { release: { ...prepared.release, status: "ready", credentialVersions: versions } }
          : action === "prepare"
            ? response
            : { operation: { ...prepared.operation, stage: "queued" } };
      }),
  });
  return {
    calls,
    setVersions: (value: Readonly<Record<string, number>>) => {
      versions = value;
    },
    layer: Layer.effect(Applications, make).pipe(
      Layer.provide(broker),
      Layer.provideMerge(Vault.layer),
      Layer.provideMerge(Store.layer),
      Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-applications-test-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}
it.effect(
  "resolves scoped vault bindings through broker stdin and returns only a queued receipt",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      yield* (yield* CredentialVault).write({
        name: "APP_KEY",
        description: "Business app key",
        valueType: "token",
        value: Redacted.make("fixture-private-app-key"),
        usage: "bindings-only",
        allowedInstances: [scope.providerInstanceId],
      });
      const result = yield* (yield* Applications).request(scope, {
        action: "publish",
        input: { projectRoot: "/projects/blog", name: "blog" },
      });
      expect(test.calls.map((call) => call.action)).toEqual(["prepare", "commit"]);
      expect(test.calls.every((call) => call.scope === scope)).toBe(true);
      expect(test.calls[0]?.credentials).toBeUndefined();
      expect(test.calls[1]?.credentials).toMatchObject({
        values: { APP_KEY: "fixture-private-app-key" },
      });
      expect(result.operation?.stage).toBe("queued");
      expect(JSON.stringify(result)).not.toContain("fixture-private-app-key");
      expect(test.calls[1]?.input).toEqual({ applicationId, operationId });
    }).pipe(Effect.provide(test.layer));
  },
);
it.effect(
  "abandons an unresolved preparation and never starts a worker with missing credentials",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const result = yield* (yield* Applications)
        .request(scope, {
          action: "publish",
          input: { projectRoot: "/projects/blog", name: "blog" },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.calls.map((call) => call.action)).toEqual(["prepare", "abandon"]);
    }).pipe(Effect.provide(test.layer));
  },
);
it.effect(
  "refuses application authority when the authenticated caller has no workspace scope",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const result = yield* (yield* Applications)
        .request(
          { providerInstanceId: scope.providerInstanceId },
          {
            action: "list",
            input: {},
          },
        )
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.calls).toEqual([]);
    }).pipe(Effect.provide(test.layer));
  },
);
it.effect(
  "start and rollback cannot revive removed or rotated historical credential values",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const vault = yield* CredentialVault;
      const apps = yield* Applications;
      const key = {
        name: "APP_KEY",
        description: "Fixture",
        valueType: "token" as const,
        value: Redacted.make("fixture-private-app-key"),
        allowedInstances: [scope.providerInstanceId],
      };
      const stored = yield* vault.write(key);
      test.setVersions({ APP_KEY: stored.credentials[0]!.updatedAt });
      yield* apps.request(scope, { action: "control", input: { applicationId, action: "start" } });
      expect(test.calls[1]?.credentials).toEqual({
        values: { APP_KEY: "fixture-private-app-key" },
        versions: { APP_KEY: stored.credentials[0]!.updatedAt },
      });
      expect(test.calls.filter((call) => call.action === "control")).toHaveLength(1);
      yield* vault.action({ action: "delete", name: "APP_KEY" });
      expect(
        (yield* apps
          .request(scope, { action: "control", input: { applicationId, action: "start" } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      yield* vault.write({ ...key, value: Redacted.make("fixture-rotated-key") });
      // Delete/recreate may have the same test clock time; advance the recorded
      // immutable version to guarantee this fixture represents a stale release.
      test.setVersions({ APP_KEY: -1 });
      expect(
        (yield* apps
          .request(scope, { action: "rollback", input: { applicationId, releaseId } })
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(test.calls.filter((call) => call.action === "control")).toHaveLength(1);
      expect(test.calls.filter((call) => call.action === "rollback")).toHaveLength(0);
      yield* apps.request(scope, { action: "control", input: { applicationId, action: "stop" } });
      expect(test.calls.at(-1)?.action).toBe("control");
    }).pipe(Effect.provide(test.layer));
  },
);

it.effect("preserves native deployment identity and resolves the same scoped credentials", () => {
  const test = fixture("systemd");
  return Effect.gen(function* () {
    yield* (yield* CredentialVault).write({
      name: "APP_KEY",
      description: "Bot token",
      valueType: "token",
      value: Redacted.make("fixture-native-token"),
      usage: "bindings-only",
      allowedInstances: [scope.providerInstanceId],
    });
    const input = {
      projectRoot: "/projects/blog",
      name: "blog",
      backend: "systemd" as const,
      deploymentProfile: "bot",
    };
    const result = yield* (yield* Applications).request(scope, { action: "publish", input });
    expect(test.calls[0]?.input).toEqual(input);
    expect(test.calls.map((call) => call.action)).toEqual(["prepare", "commit"]);
    expect(test.calls[1]?.credentials).toMatchObject({
      values: { APP_KEY: "fixture-native-token" },
    });
    expect(result.operation?.stage).toBe("queued");
    expect(result).toEqual({ operation: { ...prepared.operation, stage: "queued" } });
  }).pipe(Effect.provide(test.layer));
});

it.effect("keeps administrator approvals out of the Harness application request path", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const apps = yield* Applications;
    const review = {
      action: "approve",
      input: { requestId: "a".repeat(32), revision: "b".repeat(64), confirmRoot: true },
    } as const;
    const denied = yield* apps
      .request(scope, review as unknown as ApplicationRequest)
      .pipe(Effect.result);
    expect(denied._tag).toBe("Failure");
    expect(test.calls).toEqual([]);
    yield* apps.deploymentAdmin(scope, review);
    expect(test.calls).toMatchObject([{ action: "approve", administrator: true }]);
    expect(test.calls[0]?.credentials).toBeUndefined();
  }).pipe(Effect.provide(test.layer));
});
