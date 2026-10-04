import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CredentialVaultError,
  EnvironmentId,
  GitHubToolBinding,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Vault from "./CredentialVault.ts";
import { CredentialVault } from "./CredentialVault.ts";
import {
  GitHubBindingTransport,
  ToolBindings,
  hostGitHubEnvironment,
  make,
} from "./ToolBindings.ts";
import * as Store from "../auth/ServerSecretStore.ts";
import * as Config from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("tools-test"),
  threadId: ThreadId.make("tools-thread"),
  providerSessionId: "fixture-tools",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
  allowedFileRoots: ["/projects"],
};
import { registerProviderCredentialSocket } from "../mcp/McpProviderSession.ts";

const binding = Schema.decodeUnknownSync(GitHubToolBinding)({
  instanceId: "codex",
  enabled: true,
  host: "github.com",
  account: "owner",
  repositories: ["owner/blog"],
  source: {
    type: "github-app",
    appId: "123",
    installationId: "456",
    privateKeyCredential: "GITHUB_APP_PRIVATE_KEY",
    access: "write",
  },
});
const key = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
function fixture(options: { repositories?: ReadonlyArray<string>; hostToken?: string } = {}) {
  let minted = 0;
  let hostToken: string | undefined = options.hostToken ?? "gho_fixture_broad_host_token";
  let hostAccount = "owner";
  const requests: Array<{ path: string; body?: unknown }> = [];
  const transport = Layer.succeed(GitHubBindingTransport, {
    protectedRepositories: Effect.succeed(["owner/t3code"]),
    hostToken: Effect.suspend(() =>
      hostToken
        ? Effect.succeed(Redacted.make(hostToken))
        : Effect.fail(
            new CredentialVaultError({ reason: "The host GitHub CLI is not authenticated." }),
          ),
    ),
    request: (path, _token, body) =>
      Effect.sync(() => {
        requests.push({ path, ...(body === undefined ? {} : { body }) });
        if (path === "/user") return { login: hostAccount };
        if (path.endsWith("access_tokens")) {
          minted++;
          return {
            token: `ghs_fixture_business_${minted}`,
            expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          };
        }
        if (path.startsWith("/app/installations/")) return { account: { login: "owner" } };
        return {
          total_count: options.repositories?.length ?? 1,
          repositories: (options.repositories ?? ["owner/blog"]).map((full_name) => ({
            full_name,
          })),
        };
      }),
  });
  return {
    transport,
    requests,
    minted: () => minted,
    setHost: (token: string | undefined, account = "owner") => {
      hostToken = token;
      hostAccount = account;
    },
    layer: Layer.effect(ToolBindings, make).pipe(
      Layer.provide(transport),
      Layer.provideMerge(Vault.layer),
      Layer.provideMerge(Store.layer),
      Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-tool-bindings-" })),
      Layer.provideMerge(NodeServices.layer),
    ),
  };
}
const provision = Effect.gen(function* () {
  yield* (yield* CredentialVault).write({
    name: "GITHUB_APP_PRIVATE_KEY",
    description: "GitHub App signing key",
    valueType: "text",
    value: Redacted.make(key),
    usage: "bindings-only",
    allowedInstances: [ProviderInstanceId.make("codex")],
  });
});
it("finds the owner's existing gh login when the server uses a separate state HOME", () => {
  const environment = {
    HOME: "/state",
    PATH: "/usr/bin",
    GH_TOKEN: "unrelated-env-token",
    GH_DEBUG: "api",
  };
  expect(hostGitHubEnvironment(environment, "/home/owner")).toMatchObject({
    HOME: "/state",
    GH_CONFIG_DIR: "/home/owner/.config/gh",
    GH_TOKEN: undefined,
    GH_DEBUG: undefined,
  });
  expect(
    hostGitHubEnvironment({ ...environment, XDG_CONFIG_HOME: "/owner-config" }, "/home/owner")
      .GH_CONFIG_DIR,
  ).toBe("/owner-config/gh");
  expect(
    hostGitHubEnvironment({ ...environment, GH_CONFIG_DIR: "/explicit-gh" }, "/home/owner")
      .GH_CONFIG_DIR,
  ).toBe("/explicit-gh");
});
it.effect(
  "uses preauthorized host gh without a model grant and detects token rotation, account switches and logout",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const tools = yield* ToolBindings;
      const vault = yield* CredentialVault;
      const hostBinding = { ...binding, repositories: [], source: { type: "host-login" as const } };
      yield* tools.write(hostBinding);
      expect((yield* tools.gh(binding.instanceId))?.environment.GH_TOKEN).toBe(
        "gho_fixture_broad_host_token",
      );
      expect(yield* vault.shellEnvironment(scope)).toEqual({});
      expect(encode(yield* tools.snapshot)).not.toContain("gho_fixture_broad_host_token");
      expect((yield* tools.snapshot)[0]?.message).toContain("existing permissions");
      yield* tools.gh(binding.instanceId);
      expect(test.requests.map((request) => request.path)).toEqual(["/user"]);
      test.setHost("github_pat_fixture_rotated");
      expect((yield* tools.gh(binding.instanceId))?.environment.GH_TOKEN).toBe(
        "github_pat_fixture_rotated",
      );
      test.setHost("gho_fixture_other", "other");
      expect((yield* tools.gh(binding.instanceId).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* tools.snapshot)[0]?.status).toBe("not_allowed");
      test.setHost("gho_fixture_restored");
      expect((yield* tools.gh(binding.instanceId))?.environment.GH_TOKEN).toBe(
        "gho_fixture_restored",
      );
      test.setHost(undefined);
      expect((yield* tools.gh(binding.instanceId).pipe(Effect.result))._tag).toBe("Failure");
      expect(encode(yield* tools.snapshot)).not.toContain("gho_fixture_restored");
      test.setHost("gho_fixture_restored");
      yield* tools.write({ ...hostBinding, enabled: false });
      expect(yield* tools.gh(binding.instanceId)).toBeUndefined();
      expect((yield* tools.gh(ProviderInstanceId.make("grok")))?.environment.GH_TOKEN).toBe(
        "gho_fixture_restored",
      );
    }).pipe(Effect.provide(test.layer));
  },
);
it("keeps inherited host permissions distinct from installation repository restrictions", () => {
  const decode = Schema.decodeUnknownOption(GitHubToolBinding);
  expect(decode({ ...binding, repositories: [], source: { type: "host-login" } })._tag).toBe(
    "Some",
  );
  expect(decode({ ...binding, source: { type: "host-login" } })._tag).toBe("None");
  expect(decode({ ...binding, repositories: [] })._tag).toBe("None");
});
it.effect("new instances inherit T3's gh login without a saved binding or shell grant", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const tools = yield* ToolBindings;
    const vault = yield* CredentialVault;
    for (const id of ["claudeAgent", "codex", "grok", "codex_second"]) {
      expect((yield* tools.gh(ProviderInstanceId.make(id)))?.environment.GH_TOKEN).toBe(
        "gho_fixture_broad_host_token",
      );
    }
    const snapshot = yield* tools.snapshot;
    expect(snapshot.map((state) => state.binding.instanceId)).toEqual([
      "claudeAgent",
      "codex",
      "grok",
      "codex_second",
    ]);
    expect(snapshot.every((state) => state.status === "ready")).toBe(true);
    expect(encode(snapshot)).not.toContain("gho_fixture_broad_host_token");
    expect(yield* vault.shellEnvironment(scope)).toEqual({});

    // Automatic authorization follows T3; it does not pin a newly launched
    // instance to the account that happened to be logged in on first use.
    test.setHost("gho_fixture_new_owner", "new-owner");
    expect((yield* tools.gh(binding.instanceId))?.environment.GH_TOKEN).toBe(
      "gho_fixture_new_owner",
    );
    expect(
      (yield* tools.snapshot).find((state) => state.binding.instanceId === "codex")?.binding
        .account,
    ).toBe("new-owner");
    test.setHost(undefined);
    expect((yield* tools.gh(binding.instanceId).pipe(Effect.result))._tag).toBe("Failure");
  }).pipe(Effect.provide(test.layer));
});
it.effect("revocation survives restart, remains local to one instance, and can be reset", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const tools = yield* ToolBindings;
    yield* tools.gh(binding.instanceId);
    yield* tools.action({ instanceId: binding.instanceId, action: "delete" });
    expect(yield* tools.gh(binding.instanceId)).toBeUndefined();
    const restored = yield* make.pipe(Effect.provide(test.transport));
    expect(yield* restored.gh(binding.instanceId)).toBeUndefined();
    expect(
      (yield* restored.snapshot).find((state) => state.binding.instanceId === "codex")?.status,
    ).toBe("disabled");
    expect((yield* restored.gh(ProviderInstanceId.make("grok")))?.environment.GH_TOKEN).toBe(
      "gho_fixture_broad_host_token",
    );
    yield* restored.action({ instanceId: binding.instanceId, action: "reset" });
    expect((yield* restored.gh(binding.instanceId))?.environment.GH_TOKEN).toBe(
      "gho_fixture_broad_host_token",
    );
  }).pipe(Effect.provide(test.layer));
});
it.effect("a failed explicit binding cannot fall back to inherited host authorization", () => {
  const test = fixture();
  return Effect.gen(function* () {
    const tools = yield* ToolBindings;
    yield* tools.write(binding);
    // Its private-key credential has not been provisioned.
    expect((yield* tools.gh(binding.instanceId).pipe(Effect.result))._tag).toBe("Failure");
    expect(test.minted()).toBe(0);
    expect((yield* tools.gh(ProviderInstanceId.make("grok")))?.environment.GH_TOKEN).toBe(
      "gho_fixture_broad_host_token",
    );
    yield* tools.action({ instanceId: binding.instanceId, action: "reset" });
    expect((yield* tools.gh(binding.instanceId))?.environment.GH_TOKEN).toBe(
      "gho_fixture_broad_host_token",
    );
  }).pipe(Effect.provide(test.layer));
});
it.effect(
  "renews scoped native gh without a model credential grant and does not expose values in metadata",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const vault = yield* CredentialVault;
      const tools = yield* ToolBindings;
      yield* provision;
      yield* tools.write(binding);
      const result = yield* tools.gh(binding.instanceId);
      expect(result?.environment.GH_TOKEN).toBe("ghs_fixture_business_1");
      expect(test.requests.find((request) => request.path.endsWith("access_tokens"))?.body).toEqual(
        {
          repositories: ["blog"],
          permissions: {
            contents: "write",
            pull_requests: "write",
            issues: "write",
            metadata: "read",
          },
        },
      );
      expect(yield* vault.shellEnvironment(scope)).toEqual({});
      expect(encode(yield* tools.snapshot)).not.toContain("ghs_fixture_business_1");
      expect(encode(yield* tools.snapshot)).not.toContain(key);
      yield* tools.gh(binding.instanceId);
      expect(test.minted()).toBe(1);
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 56 * 60_000);
      try {
        expect((yield* tools.gh(binding.instanceId))?.environment.GH_TOKEN).toBe(
          "ghs_fixture_business_2",
        );
        expect(test.minted()).toBe(2);
      } finally {
        clock.mockRestore();
      }
      yield* tools.action({ instanceId: binding.instanceId, action: "delete" });
      expect(yield* tools.gh(binding.instanceId)).toBeUndefined();
      expect((yield* tools.gh(ProviderInstanceId.make("grok")))?.environment.GH_TOKEN).toBe(
        "gho_fixture_broad_host_token",
      );
    }).pipe(Effect.provide(test.layer));
  },
);
it.effect("refuses broad host user tokens and actual repository scope mismatches", () => {
  const test = fixture({ repositories: ["owner/blog", "owner/t3code"] });
  return Effect.gen(function* () {
    const tools = yield* ToolBindings;
    yield* tools.write({ ...binding, source: { type: "host-installation-token" } });
    const broad = yield* tools.gh(binding.instanceId).pipe(Effect.result);
    expect(broad._tag).toBe("Failure");
    expect(test.requests).toEqual([]);
    expect(encode(broad)).not.toContain("gho_fixture_broad_host_token");
    yield* provision;
    yield* tools.write(binding);
    expect((yield* tools.gh(binding.instanceId).pipe(Effect.result))._tag).toBe("Failure");
    expect((yield* tools.snapshot)[0]?.status).toBe("not_allowed");
    expect(encode(yield* tools.snapshot)).not.toContain("ghs_fixture_business");
    yield* tools.write({ ...binding, repositories: ["owner/t3code"] });
    const before = test.minted();
    expect((yield* tools.gh(binding.instanceId).pipe(Effect.result))._tag).toBe("Failure");
    expect(test.minted()).toBe(before);
  }).pipe(Effect.provide(test.layer));
});
it.effect(
  "binding-only keys cannot be granted to a shell and deletion invalidates cached tool access",
  () => {
    const test = fixture();
    return Effect.gen(function* () {
      const vault = yield* CredentialVault;
      const tools = yield* ToolBindings;
      yield* provision;
      yield* tools.write(binding);
      yield* tools.gh(binding.instanceId);
      const unregister = registerProviderCredentialSocket(
        scope.providerInstanceId,
        "/fixture.sock",
      );
      try {
        expect(
          (yield* vault
            .requestUse(scope, ["GITHUB_APP_PRIVATE_KEY"], "should fail")
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
      } finally {
        unregister();
      }
      yield* vault.action({ action: "delete", name: "GITHUB_APP_PRIVATE_KEY" });
      expect((yield* tools.gh(binding.instanceId).pipe(Effect.result))._tag).toBe("Failure");
      expect(yield* vault.shellEnvironment(scope)).toEqual({});
    }).pipe(Effect.provide(test.layer));
  },
);
