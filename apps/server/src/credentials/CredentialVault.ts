// @effect-diagnostics nodeBuiltinImport:off - AEAD encryption uses the host crypto implementation.
import * as NodeCrypto from "node:crypto";
import {
  CredentialVaultError,
  CredentialVaultSnapshot,
  CredentialMetadata,
  type CredentialWriteInput,
  type CredentialVaultAction,
  type CredentialInputRequest,
  type CredentialInputResult,
  type CredentialGrant,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { readProviderCredentialSocket } from "../mcp/McpProviderSession.ts";
import { publishCredentialGrants, publishToolBindings } from "./CredentialBridgeState.ts";

const StoredCredential = Schema.Struct({ ...CredentialMetadata.fields, value: Schema.String });
const StoredVault = Schema.Struct({
  version: Schema.Literal(1),
  credentials: Schema.Array(StoredCredential),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(StoredVault));
const encode = Schema.encodeSync(Schema.fromJsonString(StoredVault));
const unavailable = () =>
  new CredentialVaultError({ reason: "The credential vault is unavailable." });
const reject = (reason: string) => Effect.fail(new CredentialVaultError({ reason }));
const reserved =
  /^(?:T3_|LD_|DYLD_|XDG_|BASH|PYTHON|GIT_CONFIG)|^(?:PATH|HOME|USER|LOGNAME|SHELL|ENV|NODE_OPTIONS|CODEX_HOME|CLAUDE_CONFIG_DIR|GROK_HOME)$/;
type Stored = typeof StoredCredential.Type;
interface GrantRecord {
  readonly metadata: CredentialGrant;
  readonly sessionId: string;
}

export class CredentialVault extends Context.Service<
  CredentialVault,
  {
    readonly revision: SubscriptionRef.SubscriptionRef<number>;
    readonly snapshot: Effect.Effect<CredentialVaultSnapshot>;
    readonly write: (
      input: CredentialWriteInput,
    ) => Effect.Effect<CredentialVaultSnapshot, CredentialVaultError>;
    readonly action: (
      input: CredentialVaultAction,
    ) => Effect.Effect<CredentialVaultSnapshot, CredentialVaultError>;
    readonly list: (scope: McpInvocationScope) => Effect.Effect<ReadonlyArray<CredentialMetadata>>;
    readonly requestInput: (
      scope: McpInvocationScope,
      input: Pick<
        CredentialInputRequest,
        "name" | "description" | "valueType" | "purpose" | "usage"
      >,
    ) => Effect.Effect<CredentialInputRequest, CredentialVaultError>;
    readonly requestInputAndWait: (
      scope: McpInvocationScope,
      input: Pick<
        CredentialInputRequest,
        "name" | "description" | "valueType" | "purpose" | "usage"
      >,
    ) => Effect.Effect<CredentialInputResult, CredentialVaultError>;
    readonly requestUse: (
      scope: McpInvocationScope,
      names: ReadonlyArray<string>,
      purpose: string,
    ) => Effect.Effect<CredentialGrant, CredentialVaultError>;
    readonly revokeUse: (scope: McpInvocationScope, id: string) => Effect.Effect<boolean>;
    /** Owner-configured MCP bindings are resolved only for the invoking instance. */
    readonly mcpEnvironment: (
      scope: McpInvocationScope,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<Readonly<Record<string, string>>, CredentialVaultError>;
    /** Only the local shell broker consumes values; MCP handlers receive metadata. */
    readonly shellEnvironment: (
      scope: McpInvocationScope,
    ) => Effect.Effect<Readonly<Record<string, string>>>;
    readonly resolveBinding: (
      instanceId: ProviderInstanceId,
      names: ReadonlyArray<string>,
    ) => Effect.Effect<
      { values: Readonly<Record<string, string>>; versions: Readonly<Record<string, number>> },
      CredentialVaultError
    >;
  }
>()("t3/credentials/CredentialVault") {}

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const key = yield* store
    .getOrCreateRandom("credential-vault-key", 32)
    .pipe(Effect.mapError(unavailable));
  const persisted = yield* store.get("credential-vault").pipe(Effect.mapError(unavailable));
  let records = yield* Effect.try({
    try: () => {
      if (Option.isNone(persisted)) return new Map<string, Stored>();
      const bytes = Buffer.from(persisted.value);
      const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const data = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
      return new Map(
        decode(data.toString("utf8")).credentials.map((record) => [record.name, record]),
      );
    },
    catch: unavailable,
  });
  let requests = new Map<string, CredentialInputRequest>();
  const inputCompletions = new Map<string, Deferred.Deferred<CredentialInputResult>>();
  let grants = new Map<string, GrantRecord>();
  const revision = yield* SubscriptionRef.make(0);
  const lock = yield* Semaphore.make(1);
  const notify = SubscriptionRef.update(revision, (value) => value + 1);
  const syncTools = Effect.tryPromise({ try: publishToolBindings, catch: unavailable });
  const syncBridge = () =>
    Effect.tryPromise({
      try: () =>
        publishCredentialGrants(
          [...grants.values()].map(({ metadata: grant, sessionId }) => ({
            sessionId,
            instanceId: grant.instanceId,
            threadId: grant.threadId,
            expiresAt: grant.expiresAt,
            environment: Object.fromEntries(
              grant.names.flatMap((name) => {
                const record = records.get(name);
                return record?.allowedInstances.includes(grant.instanceId)
                  ? [[name, record.value]]
                  : [];
              }),
            ),
          })),
        ),
      catch: unavailable,
    });
  const metadata = ({ value: _value, ...rest }: Stored): CredentialMetadata => rest;
  const completeInput = Effect.fnUntraced(function* (
    id: string,
    status: CredentialInputResult["status"],
    credential?: CredentialMetadata,
  ) {
    const request = requests.get(id);
    const completion = inputCompletions.get(id);
    requests.delete(id);
    inputCompletions.delete(id);
    if (request && completion)
      yield* Deferred.succeed(completion, {
        request,
        status,
        ...(credential ? { credential } : {}),
      });
  });
  const snapshot = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return {
      credentials: [...records.values()].map(metadata).sort((a, b) => a.name.localeCompare(b.name)),
      requests: [...requests.values()].filter((request) => now - request.createdAt < 60 * 60_000),
      grants: [...grants.values()]
        .map((grant) => grant.metadata)
        .filter((grant) => grant.expiresAt > now),
    } satisfies CredentialVaultSnapshot;
  });
  const persist = Effect.fn("CredentialVault.persist")(function* (
    next: ReadonlyMap<string, Stored>,
  ) {
    const iv = yield* crypto.randomBytes(12).pipe(Effect.mapError(unavailable));
    const bytes = yield* Effect.try({
      try: () => {
        const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([
          cipher.update(encode({ version: 1, credentials: [...next.values()] }), "utf8"),
          cipher.final(),
        ]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      catch: unavailable,
    });
    yield* store.set("credential-vault", bytes).pipe(Effect.mapError(unavailable));
    records = new Map(next);
  });
  const revokeName = (name: string) => {
    grants = new Map([...grants].filter(([, grant]) => !grant.metadata.names.includes(name)));
  };
  const write = Effect.fn("CredentialVault.write")(function* (input: CredentialWriteInput) {
    if (reserved.test(input.name))
      return yield* reject("This name is reserved for the execution environment.");
    const value = input.value ? Redacted.value(input.value) : records.get(input.name)?.value;
    if (!value) return yield* reject("A new credential requires a value.");
    if (value.includes("\0")) return yield* reject("A credential cannot contain a NUL character.");
    const now = yield* Clock.currentTimeMillis;
    const pending = input.requestId ? requests.get(input.requestId) : undefined;
    if (
      input.requestId &&
      (!pending ||
        now - pending.createdAt >= 60 * 60_000 ||
        pending.name !== input.name ||
        !input.allowedInstances.includes(pending.instanceId))
    )
      return yield* reject("The input request is unavailable or its instance is not authorized.");
    const updatedAt = Math.max(now, (records.get(input.name)?.updatedAt ?? 0) + 1);
    const usage = input.usage ?? records.get(input.name)?.usage ?? pending?.usage;
    const next = new Map(records);
    next.set(input.name, {
      name: input.name,
      description: input.description,
      valueType: input.valueType,
      allowedInstances: [...new Set(input.allowedInstances)],
      value,
      length: [...value].length,
      updatedAt,
      ...(usage ? { usage } : {}),
    });
    yield* persist(next);
    revokeName(input.name);
    if (input.requestId)
      yield* completeInput(input.requestId, "configured", metadata(next.get(input.name)!));
    yield* notify;
    yield* syncBridge();
    return yield* snapshot;
  });
  const action = Effect.fn("CredentialVault.action")(function* (input: CredentialVaultAction) {
    if (input.action === "delete") {
      const next = new Map(records);
      next.delete(input.name);
      yield* persist(next);
      revokeName(input.name);
    } else if (input.action === "revoke") grants.delete(input.id);
    else yield* completeInput(input.id, "dismissed");
    yield* notify;
    yield* syncBridge();
    return yield* snapshot;
  });
  const list = (scope: McpInvocationScope) =>
    Effect.sync(() =>
      [...records.values()]
        .filter((record) => record.allowedInstances.includes(scope.providerInstanceId))
        .map(metadata),
    );
  const requestInput = Effect.fn("CredentialVault.requestInput")(function* (
    scope: McpInvocationScope,
    input: Pick<CredentialInputRequest, "name" | "description" | "valueType" | "purpose" | "usage">,
  ) {
    if (reserved.test(input.name))
      return yield* reject("This name is reserved for the execution environment.");
    const now = yield* Clock.currentTimeMillis;
    for (const request of requests.values())
      if (now - request.createdAt >= 60 * 60_000) yield* completeInput(request.id, "expired");
    const previous = [...requests.values()].find(
      (request) =>
        request.threadId === scope.threadId &&
        request.instanceId === scope.providerInstanceId &&
        request.name === input.name,
    );
    if (previous) return previous;
    if (requests.size >= 100) return yield* reject("Too many pending credential input requests.");
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
    const request = {
      ...input,
      id,
      threadId: scope.threadId,
      instanceId: scope.providerInstanceId,
      createdAt: now,
    };
    requests.set(id, request);
    inputCompletions.set(id, yield* Deferred.make<CredentialInputResult>());
    yield* notify;
    return request;
  });
  const requestInputAndWait = Effect.fn("CredentialVault.requestInputAndWait")(function* (
    scope: McpInvocationScope,
    input: Pick<CredentialInputRequest, "name" | "description" | "valueType" | "purpose" | "usage">,
  ) {
    const { request, completion } = yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const request = yield* requestInput(scope, input);
        return { request, completion: inputCompletions.get(request.id)! };
      }),
    );
    // Await outside the mutation lock: the owner's HTTP submission completes
    // the native MCP call, so the harness continues its existing turn.
    const result = yield* Deferred.await(completion).pipe(
      Effect.timeoutOption("15 minutes"),
      Effect.onInterrupt(() =>
        lock.withPermits(1)(completeInput(request.id, "dismissed").pipe(Effect.andThen(notify))),
      ),
    );
    if (Option.isSome(result)) return result.value;
    yield* lock.withPermits(1)(completeInput(request.id, "expired").pipe(Effect.andThen(notify)));
    return { request, status: "expired" as const };
  });
  const requestUse = Effect.fn("CredentialVault.requestUse")(function* (
    scope: McpInvocationScope,
    names: ReadonlyArray<string>,
    purpose: string,
  ) {
    if (!scope.allowedFileRoots || !readProviderCredentialSocket(scope.providerInstanceId))
      return yield* reject("Credential use requires an enabled Linux sandbox with a shell bridge.");
    if (
      names.length === 0 ||
      names.some(
        (name) =>
          !records.get(name)?.allowedInstances.includes(scope.providerInstanceId) ||
          records.get(name)?.usage === "bindings-only",
      )
    )
      return yield* reject("The requested variables are not available to this provider instance.");
    const now = yield* Clock.currentTimeMillis;
    grants = new Map([...grants].filter(([, grant]) => grant.metadata.expiresAt > now));
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable));
    const grant = {
      id,
      names: [...new Set(names)],
      purpose,
      threadId: scope.threadId,
      instanceId: scope.providerInstanceId,
      expiresAt: now + 15 * 60_000,
    };
    grants.set(id, { metadata: grant, sessionId: scope.providerSessionId });
    yield* notify;
    yield* syncBridge().pipe(
      Effect.onError(() =>
        Effect.sync(() => grants.delete(id)).pipe(Effect.andThen(syncBridge().pipe(Effect.ignore))),
      ),
    );
    return grant;
  });
  const shellEnvironment = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const environment: Record<string, string> = {};
      for (const { metadata: grant, sessionId } of grants.values()) {
        if (
          sessionId !== scope.providerSessionId ||
          grant.instanceId !== scope.providerInstanceId ||
          grant.threadId !== scope.threadId ||
          grant.expiresAt <= now
        )
          continue;
        for (const name of grant.names) {
          const record = records.get(name);
          if (record?.allowedInstances.includes(scope.providerInstanceId))
            environment[name] = record.value;
        }
      }
      return environment;
    });
  const revokeUse = (scope: McpInvocationScope, id: string) =>
    Effect.gen(function* () {
      const grant = grants.get(id);
      if (
        !grant ||
        grant.sessionId !== scope.providerSessionId ||
        grant.metadata.instanceId !== scope.providerInstanceId ||
        grant.metadata.threadId !== scope.threadId
      )
        return false;
      grants.delete(id);
      yield* notify;
      yield* syncBridge().pipe(Effect.orDie);
      return true;
    });
  const mcpEnvironment = (scope: McpInvocationScope, names: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const values: Record<string, string> = {};
      for (const name of names) {
        const record = records.get(name);
        if (!record?.allowedInstances.includes(scope.providerInstanceId))
          return yield* reject(
            "An MCP credential binding is missing or not authorized for this instance.",
          );
        values[name] = record.value;
      }
      return values;
    });
  const resolveBinding = (instanceId: ProviderInstanceId, names: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const values: Record<string, string> = {};
      const versions: Record<string, number> = {};
      for (const name of names) {
        const record = records.get(name);
        if (!record?.allowedInstances.includes(instanceId))
          return yield* reject(
            "A tool or application credential is missing or not authorized for this instance.",
          );
        values[name] = record.value;
        versions[name] = record.updatedAt;
      }
      return { values, versions };
    });
  return CredentialVault.of({
    revision,
    snapshot: lock.withPermits(1)(snapshot),
    write: (input) =>
      lock
        .withPermits(1)(write(input))
        .pipe(Effect.tap(() => syncTools)),
    action: (input) =>
      lock
        .withPermits(1)(action(input))
        .pipe(Effect.tap(() => syncTools)),
    list,
    requestInput: (scope, input) => lock.withPermits(1)(requestInput(scope, input)),
    requestInputAndWait,
    requestUse: (scope, names, purpose) => lock.withPermits(1)(requestUse(scope, names, purpose)),
    shellEnvironment: (scope) => lock.withPermits(1)(shellEnvironment(scope)),
    revokeUse: (scope, id) => lock.withPermits(1)(revokeUse(scope, id)),
    mcpEnvironment: (scope, names) => lock.withPermits(1)(mcpEnvironment(scope, names)),
    resolveBinding: (instanceId, names) => lock.withPermits(1)(resolveBinding(instanceId, names)),
  });
});
export const layer = Layer.effect(CredentialVault, make);
