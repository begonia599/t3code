// @effect-diagnostics nodeBuiltinImport:off - Native RSA signing and gh authentication stay in the host boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CredentialVaultError,
  GitHubToolBinding,
  ToolBindingState,
  type ToolBindingAction,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { CredentialVault } from "./CredentialVault.ts";
import { publishToolBindings } from "./CredentialBridgeState.ts";

const Policy = Schema.Struct({
  protectedRepositories: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
});
const Stored = Schema.Array(GitHubToolBinding);
const Installation = Schema.Struct({ account: Schema.Struct({ login: Schema.String }) });
const Account = Schema.Struct({ login: Schema.String });
const Repo = Schema.Struct({ full_name: Schema.String });
const Repositories = Schema.Struct({
  total_count: Schema.Number,
  repositories: Schema.Array(Repo),
});
const Minted = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
  repositories: Schema.optionalKey(Schema.Array(Repo)),
});
const decodeUnknownJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodePolicy = Schema.decodeUnknownSync(Schema.fromJsonString(Policy));
const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(Stored));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Stored));
const decodeInstallation = Schema.decodeUnknownEffect(Installation);
const decodeAccount = Schema.decodeUnknownEffect(Account);
const decodeMinted = Schema.decodeUnknownEffect(Minted);
const decodeRepositories = Schema.decodeUnknownEffect(Repositories);
const fail = (reason: string) => new CredentialVaultError({ reason });

/** The server's state HOME may differ from the resource owner's login HOME. */
export const hostGitHubEnvironment = (environment: NodeJS.ProcessEnv, ownerHome: string) => ({
  ...environment,
  GH_CONFIG_DIR:
    environment.GH_CONFIG_DIR ||
    NodePath.join(environment.XDG_CONFIG_HOME || NodePath.join(ownerHome, ".config"), "gh"),
  GH_TOKEN: undefined,
  GITHUB_TOKEN: undefined,
  GH_ENTERPRISE_TOKEN: undefined,
  GITHUB_ENTERPRISE_TOKEN: undefined,
  GH_DEBUG: undefined,
});
export interface ToolEnvironment {
  readonly environment: Readonly<Record<string, string>>;
  readonly expiresAt: number;
}
export class ToolBindings extends Context.Service<
  ToolBindings,
  {
    readonly revision: SubscriptionRef.SubscriptionRef<number>;
    readonly snapshot: Effect.Effect<ReadonlyArray<ToolBindingState>>;
    readonly write: (binding: GitHubToolBinding) => Effect.Effect<void, CredentialVaultError>;
    readonly action: (action: ToolBindingAction) => Effect.Effect<void, CredentialVaultError>;
    readonly gh: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ToolEnvironment | undefined, CredentialVaultError>;
  }
>()("t3/credentials/ToolBindings") {}

/** Authentication transport only. Operations continue through native gh and Source Control. */
export class GitHubBindingTransport extends Context.Service<
  GitHubBindingTransport,
  {
    readonly request: (
      path: string,
      token: Redacted.Redacted<string>,
      body?: unknown,
    ) => Effect.Effect<unknown, CredentialVaultError>;
    readonly hostToken: Effect.Effect<Redacted.Redacted<string>, CredentialVaultError>;
    readonly protectedRepositories: Effect.Effect<ReadonlyArray<string>, CredentialVaultError>;
  }
>()("t3/credentials/GitHubBindingTransport") {
  static readonly layer = Layer.succeed(GitHubBindingTransport, {
    request: (path, token, body) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`https://api.github.com${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Authorization: `Bearer ${Redacted.value(token)}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "Content-Type": "application/json",
              "User-Agent": "T3-Code",
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(10_000),
            redirect: "error",
          });
          if (!response.ok)
            throw fail(
              "GitHub rejected this binding. Check the installation, repository selection and credential validity.",
            );
          const bytes = await response.text();
          if (bytes.length > 1024 * 1024)
            throw fail("GitHub returned an oversized authentication response.");
          return decodeUnknownJson(bytes);
        },
        catch: () =>
          fail(
            "GitHub authentication could not be verified; no alternate credential will be used.",
          ),
      }),
    hostToken: Effect.callback<Redacted.Redacted<string>, CredentialVaultError>((resume) => {
      const child = NodeChildProcess.execFile(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        {
          timeout: 5000,
          maxBuffer: 65536,
          env: hostGitHubEnvironment(process.env, NodeOS.userInfo().homedir),
        },
        (error, stdout) => {
          resume(
            error
              ? Effect.fail(fail("The host GitHub CLI is not authenticated."))
              : Effect.succeed(Redacted.make(stdout.trim())),
          );
        },
      );
      return Effect.sync(() => {
        if (child.exitCode === null) child.kill();
      });
    }),
    protectedRepositories: Effect.tryPromise({
      try: async () => {
        const path = "/etc/t3code/resources.json";
        for (const parent of [path, "/etc/t3code", "/etc", "/"]) {
          const info = await NodeFSP.lstat(parent);
          if (info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0)
            throw fail("The host resource protection policy is not trusted.");
        }
        return decodePolicy(await NodeFSP.readFile(path, "utf8")).protectedRepositories;
      },
      catch: () =>
        fail("Configure the root-owned protected repository policy before binding GitHub tools."),
    }),
  });
}

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore;
  const vault = yield* CredentialVault;
  const transport = yield* GitHubBindingTransport;
  const stored = yield* store
    .get("github-tool-bindings")
    .pipe(Effect.mapError(() => fail("Could not read tool bindings.")));
  const configs = yield* Effect.try({
    try: () =>
      new Map(
        (Option.isSome(stored) ? decodeStored(Buffer.from(stored.value).toString()) : []).map(
          (binding) => [binding.instanceId, binding],
        ),
      ),
    catch: () => fail("Invalid persisted GitHub tool bindings."),
  });
  const states = new Map<ProviderInstanceId, ToolBindingState>();
  const cache = new Map<ProviderInstanceId, { result: ToolEnvironment; version: string }>();
  const revision = yield* SubscriptionRef.make(0);
  const lock = yield* Semaphore.make(1);
  const save = () =>
    store
      .set("github-tool-bindings", Buffer.from(encodeStored([...configs.values()])))
      .pipe(Effect.mapError(() => fail("Could not save tool bindings.")));
  const notify = SubscriptionRef.update(revision, (value) => value + 1);
  const syncTools = Effect.tryPromise({
    try: publishToolBindings,
    catch: () =>
      fail("Could not synchronize tool authorization. Verify the saved binding before use."),
  });
  const inspect = Effect.fn("ToolBindings.inspect")(function* (instanceId: ProviderInstanceId) {
    const binding = configs.get(instanceId);
    if (!binding || !binding.enabled) return undefined;
    if (binding.source.type === "host-login") {
      // Re-read on every native start: logout or switching the host account
      // must invalidate cached access even before the verification lease ends.
      const token = yield* transport.hostToken;
      const version = NodeCrypto.createHash("sha256").update(Redacted.value(token)).digest("hex");
      const cached = cache.get(instanceId);
      if (cached && cached.version === version && cached.result.expiresAt > Date.now())
        return cached.result;
      const account = yield* transport.request("/user", token).pipe(
        Effect.flatMap(decodeAccount),
        Effect.mapError(() => fail("The host GitHub login could not be verified.")),
      );
      if (account.login.toLowerCase() !== binding.account.toLowerCase())
        return yield* fail(
          "The host GitHub account does not match this binding. Recheck the selected account.",
        );
      const expiresAt = Date.now() + 5 * 60_000;
      const result = {
        environment: { GH_HOST: "github.com", GH_TOKEN: Redacted.value(token), GH_DEBUG: "" },
        expiresAt,
      };
      cache.set(instanceId, { result, version });
      states.set(instanceId, {
        binding,
        status: "ready",
        message:
          "Native gh uses the resource owner's existing GitHub login with its existing permissions. Git HTTPS and SSH authentication are separate.",
        checkedAt: Date.now(),
      });
      return result;
    }
    const protectedRepos = new Set(
      (yield* transport.protectedRepositories).map((value) => value.toLowerCase()),
    );
    if (binding.repositories.some((repository) => protectedRepos.has(repository.toLowerCase())))
      return yield* fail("The tool binding includes a protected framework repository.");
    if (
      binding.repositories.some(
        (repository) => repository.split("/")[0]!.toLowerCase() !== binding.account.toLowerCase(),
      )
    )
      return yield* fail("The selected account must own every bound repository.");
    const names =
      binding.source.type === "github-app"
        ? [binding.source.privateKeyCredential]
        : binding.source.type === "vault-installation-token"
          ? [binding.source.credential]
          : [];
    const resolved = yield* vault.resolveBinding(instanceId, names);
    const version = JSON.stringify(resolved.versions);
    const cached = cache.get(instanceId);
    if (cached && cached.version === version && cached.result.expiresAt > Date.now() + 5 * 60_000)
      return cached.result;
    let token: Redacted.Redacted<string>;
    let expiresAt: number;
    if (binding.source.type === "github-app") {
      const source = binding.source;
      const jwt = yield* Effect.try({
        try: () => {
          const seconds = Math.floor(Date.now() / 1000);
          const prefix =
            Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url") +
            "." +
            Buffer.from(
              JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: source.appId }),
            ).toString("base64url");
          return Redacted.make(
            prefix +
              "." +
              NodeCrypto.sign(
                "RSA-SHA256",
                Buffer.from(prefix),
                resolved.values[source.privateKeyCredential]!,
              ).toString("base64url"),
          );
        },
        catch: () => fail("The GitHub App private key is invalid."),
      });
      const installation = yield* transport
        .request(`/app/installations/${source.installationId}`, jwt)
        .pipe(
          Effect.flatMap(decodeInstallation),
          Effect.mapError(() => fail("The GitHub App installation is unavailable.")),
        );
      if (installation.account.login.toLowerCase() !== binding.account.toLowerCase())
        return yield* fail("The GitHub installation account does not match this binding.");
      const permissions =
        source.access === "write"
          ? { contents: "write", pull_requests: "write", issues: "write", metadata: "read" }
          : { contents: "read", pull_requests: "read", issues: "read", metadata: "read" };
      const minted = yield* transport
        .request(`/app/installations/${source.installationId}/access_tokens`, jwt, {
          repositories: binding.repositories.map((repository) => repository.split("/")[1]),
          permissions,
        })
        .pipe(
          Effect.flatMap(decodeMinted),
          Effect.mapError(() =>
            fail("GitHub could not issue a repository-scoped tool credential."),
          ),
        );
      token = Redacted.make(minted.token);
      expiresAt = Date.parse(minted.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000)
        return yield* fail("GitHub returned an expired installation credential.");
    } else {
      token =
        binding.source.type === "host-installation-token"
          ? yield* transport.hostToken
          : Redacted.make(resolved.values[binding.source.credential]!);
      // Ordinary user tokens cannot prove their effective fine-grained write
      // scope through /user or repo.permissions. Do not label them restricted.
      if (!Redacted.value(token).startsWith("ghs_"))
        return yield* fail(
          "This source is a user token with unverifiable repository scope. Use a GitHub App installation credential or the renewable GitHub App binding.",
        );
      expiresAt = Date.now() + 5 * 60_000; // Reverify an externally managed token at every subsequent tool start.
    }
    const accessible = yield* transport
      .request("/installation/repositories?per_page=100", token)
      .pipe(
        Effect.flatMap(decodeRepositories),
        Effect.mapError(() =>
          fail("The credential is not a verifiable GitHub App installation token."),
        ),
      );
    const allowed = new Set(binding.repositories.map((value) => value.toLowerCase()));
    if (
      accessible.total_count !== accessible.repositories.length ||
      accessible.repositories.length === 0 ||
      accessible.repositories.some(
        (repository) =>
          protectedRepos.has(repository.full_name.toLowerCase()) ||
          !allowed.has(repository.full_name.toLowerCase()),
      ) ||
      allowed.size !== accessible.repositories.length
    )
      return yield* fail(
        "The credential's actual repositories do not match the approved business repository set.",
      );
    const result = {
      environment: { GH_HOST: "github.com", GH_TOKEN: Redacted.value(token), GH_DEBUG: "" },
      expiresAt,
    };
    cache.set(instanceId, { result, version });
    states.set(instanceId, {
      binding,
      status: "ready",
      message:
        "Native gh is authorized for the selected business repositories. Git HTTPS and SSH authentication are separate.",
      expiresAt: new Date(expiresAt).toISOString(),
      checkedAt: Date.now(),
    });
    return result;
  });
  const gh = (instanceId: ProviderInstanceId) =>
    lock.withPermits(1)(
      inspect(instanceId).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            cache.delete(instanceId);
            const binding = configs.get(instanceId);
            if (binding)
              states.set(instanceId, {
                binding,
                status: "not_allowed",
                message: error.reason,
                checkedAt: Date.now(),
              });
          }),
        ),
      ),
    );
  return ToolBindings.of({
    revision,
    snapshot: lock.withPermits(1)(
      Effect.sync(() =>
        [...configs.values()].map((binding) =>
          binding.enabled
            ? (states.get(binding.instanceId) ?? {
                binding,
                status: "not_checked" as const,
                message: "Check this binding before use.",
              })
            : { binding, status: "disabled" as const, message: "The tool binding is disabled." },
        ),
      ),
    ),
    gh,
    write: (binding) =>
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const previous = configs.get(binding.instanceId);
            configs.set(binding.instanceId, binding);
            yield* save().pipe(
              Effect.onError(() =>
                Effect.sync(() => {
                  if (previous) configs.set(binding.instanceId, previous);
                  else configs.delete(binding.instanceId);
                }),
              ),
            );
            cache.delete(binding.instanceId);
            states.delete(binding.instanceId);
            yield* notify;
          }),
        )
        .pipe(Effect.andThen(syncTools)),
    action: (input) =>
      input.action === "check"
        ? gh(input.instanceId).pipe(
            Effect.asVoid,
            Effect.ensuring(notify),
            Effect.ensuring(syncTools.pipe(Effect.ignore)),
          )
        : lock
            .withPermits(1)(
              Effect.gen(function* () {
                const previous = configs.get(input.instanceId);
                configs.delete(input.instanceId);
                yield* save().pipe(
                  Effect.onError(() =>
                    Effect.sync(() => {
                      if (previous) configs.set(input.instanceId, previous);
                    }),
                  ),
                );
                cache.delete(input.instanceId);
                states.delete(input.instanceId);
                yield* notify;
              }),
            )
            .pipe(Effect.andThen(syncTools)),
  });
});
export const layer = Layer.effect(ToolBindings, make).pipe(
  Layer.provide(GitHubBindingTransport.layer),
);
