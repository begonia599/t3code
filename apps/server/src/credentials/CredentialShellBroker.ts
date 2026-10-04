// @effect-diagnostics nodeBuiltinImport:off - Unix socket transport for native shell processes.
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { CredentialVaultError } from "@t3tools/contracts";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { CredentialVault } from "./CredentialVault.ts";
import { ToolBindings } from "./ToolBindings.ts";
import {
  observeCredentialGrants,
  observeCredentialSessions,
  observeToolBindings,
  type CredentialBridgeGrant,
} from "./CredentialBridgeState.ts";
import {
  readProviderCredentialSocket,
  registerMcpSessionDisposer,
} from "../mcp/McpProviderSession.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

const Request = Schema.Struct({
  authorization: Schema.String.check(Schema.isMaxLength(512)),
  tool: Schema.optionalKey(Schema.Literal("gh")),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Request));
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export class CredentialShellBroker extends Context.Service<
  CredentialShellBroker,
  {
    readonly open: (directory: string) => Effect.Effect<string, CredentialVaultError>;
  }
>()("t3/credentials/CredentialShellBroker") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const registry = yield* McpSessionRegistry;
  const vault = yield* CredentialVault;
  const bindings = yield* Effect.serviceOption(ToolBindings);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const servers = new Map<string, { path: string; server: NodeNet.Server }>();
  const lock = yield* Semaphore.make(1);
  const sockets = new Set<NodeNet.Socket>();
  const sessions = new Map<
    string,
    { scope: McpInvocationScope; authorization: string; file: string }
  >();
  let cachedGrants: ReadonlyArray<CredentialBridgeGrant> = [];
  const cachedTools = new Map<string, unknown>();
  let toolRefreshEpoch = 0;
  const failed = () =>
    new CredentialVaultError({ reason: "The native shell credential bridge is unavailable." });
  const writeGrantFile = (entry: {
    scope: McpInvocationScope;
    authorization: string;
    file: string;
  }) =>
    Effect.gen(function* () {
      const tools = cachedTools.get(entry.scope.providerInstanceId) ?? {};
      const grants = cachedGrants.filter(
        (grant) =>
          grant.sessionId === entry.scope.providerSessionId &&
          grant.instanceId === entry.scope.providerInstanceId &&
          grant.threadId === entry.scope.threadId,
      );
      const key = NodeCrypto.createHash("sha256")
        .update("t3-credential-bridge-v1\0" + entry.authorization)
        .digest();
      const nonce = yield* crypto.randomBytes(12).pipe(Effect.mapError(failed));
      const encrypted = yield* Effect.try({
        try: () => {
          const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
          cipher.setAAD(Buffer.from("t3-credential-bridge-v1"));
          return Buffer.concat([
            nonce,
            cipher.update(
              encode({
                grants: grants.map(({ environment, expiresAt }) => ({ environment, expiresAt })),
                ...(Option.isSome(bindings) ? { tools } : {}),
              }),
              "utf8",
            ),
            cipher.final(),
            cipher.getAuthTag(),
          ]);
        },
        catch: failed,
      });
      const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed));
      const temporary = `${entry.file}.${id}.tmp`;
      yield* fs.writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" }).pipe(
        Effect.andThen(fs.rename(temporary, entry.file)),
        Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
        Effect.onError(() => fs.remove(entry.file).pipe(Effect.ignore)),
        Effect.mapError(failed),
      );
    });
  const refreshTools = Effect.gen(function* () {
    if (Option.isNone(bindings)) return;
    const epoch = ++toolRefreshEpoch;
    const instances = [
      ...new Set([...sessions.values()].map((entry) => entry.scope.providerInstanceId)),
    ];
    // Resolve vault values before taking the file publication lock. Vault
    // mutations publish shell grants under their own lock; reversing that
    // order here would deadlock as soon as a gh binding was configured.
    const resolved = yield* Effect.forEach(instances, (instanceId) =>
      bindings.value.gh(instanceId).pipe(
        Effect.match({
          onFailure: (error) => ({ gh: { error: error.reason } }),
          onSuccess: (gh) => (gh ? { gh } : {}),
        }),
        Effect.map((tools) => [instanceId, tools] as const),
      ),
    );
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        if (epoch !== toolRefreshEpoch) return;
        for (const [instanceId, tools] of resolved) cachedTools.set(instanceId, tools);
        yield* Effect.forEach(sessions.values(), writeGrantFile).pipe(
          Effect.onError(() =>
            Effect.forEach(sessions.values(), (entry) => fs.remove(entry.file).pipe(Effect.ignore)),
          ),
        );
      }),
    );
  });
  const stopTools = observeToolBindings(() => runPromise(refreshTools));
  yield* Effect.addFinalizer(() => Effect.sync(stopTools));
  if (Option.isSome(bindings)) {
    // The file transport also serves native sandboxes without AF_UNIX.
    yield* Effect.forever(
      Effect.sleep("2 minutes").pipe(Effect.andThen(refreshTools), Effect.ignore),
    ).pipe(Effect.forkScoped);
  }
  const stopGrants = observeCredentialGrants((grants) =>
    runPromise(
      lock.withPermits(1)(
        Effect.gen(function* () {
          cachedGrants = grants;
          yield* Effect.forEach(sessions.values(), writeGrantFile).pipe(
            Effect.onError(() =>
              Effect.gen(function* () {
                cachedGrants = [];
                // A failed publication must not leave another session's old grants usable.
                for (const entry of sessions.values())
                  yield* fs.remove(entry.file).pipe(Effect.ignore);
              }),
            ),
          );
        }),
      ),
    ),
  );
  const stopSessions = observeCredentialSessions((scope, authorization) =>
    runPromise(
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const socket = readProviderCredentialSocket(scope.providerInstanceId);
            if (!socket || ![...servers.values()].some((entry) => entry.path === socket)) return;
            const id = NodeCrypto.createHash("sha256").update(authorization).digest("hex");
            const entry = { scope, authorization, file: `${socket}.${id}.grant` };
            sessions.set(scope.providerSessionId, entry);
            yield* writeGrantFile(entry);
          }),
        )
        .pipe(Effect.andThen(refreshTools)),
    ),
  );
  const stopDisposer = registerMcpSessionDisposer((sessionId) =>
    runPromise(
      lock.withPermits(1)(
        Effect.gen(function* () {
          const entry = sessions.get(sessionId);
          if (!entry) return;
          sessions.delete(sessionId);
          yield* fs.remove(entry.file).pipe(Effect.ignore);
        }),
      ),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      stopGrants();
      stopSessions();
      stopDisposer();
      for (const entry of sessions.values()) yield* fs.remove(entry.file).pipe(Effect.ignore);
      for (const socket of sockets) socket.destroy();
      for (const entry of servers.values()) {
        yield* Effect.promise(
          () => new Promise<void>((resolve) => entry.server.close(() => resolve())),
        );
        yield* fs.remove(entry.path).pipe(Effect.ignore);
      }
    }),
  );
  const open = Effect.fn("CredentialShellBroker.open")(function* (directory: string) {
    const existing = servers.get(directory);
    if (existing) return existing.path;
    const id = yield* crypto.randomUUIDv4.pipe(Effect.mapError(failed));
    const socketPath = path.join(directory, `${id}.sock`);
    const server = NodeNet.createServer((socket) => {
      sockets.add(socket);
      socket.setTimeout(5000, () => socket.destroy());
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      let buffer = "";
      let received = false;
      socket.on("data", (data) => {
        if (received) return;
        buffer += data.toString("utf8");
        if (Buffer.byteLength(buffer) > 8192) {
          socket.destroy();
          return;
        }
        if (!buffer.includes("\n")) return;
        received = true;
        const request = Effect.try({ try: () => decode(buffer.split("\n", 1)[0]!), catch: failed });
        // Shell grants use a distinct local credential, with the same lifetime checks.
        void runPromise(
          request.pipe(
            Effect.flatMap(({ authorization, tool }) =>
              registry.resolveCredential(authorization.replace(/^Bearer\s+/, "")).pipe(
                Effect.flatMap((scope) => {
                  if (!scope) return Effect.fail(failed());
                  if (tool)
                    return Option.isSome(bindings)
                      ? bindings.value
                          .gh(scope.providerInstanceId)
                          .pipe(Effect.map((gh) => gh?.environment ?? {}))
                      : Effect.succeed({});
                  return vault.shellEnvironment(scope);
                }),
              ),
            ),
            Effect.match({
              onFailure: () => ({ ok: false }),
              onSuccess: (environment) => ({ ok: true, environment }),
            }),
          ),
        ).then(
          (result) => socket.end(JSON.stringify(result) + "\n"),
          () => socket.end('{"ok":false}\n'),
        );
      });
    });
    yield* Effect.tryPromise({
      try: () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, () => {
            server.removeListener("error", reject);
            resolve();
          });
        }),
      catch: failed,
    });
    yield* fs.chmod(socketPath, 0o600).pipe(
      Effect.onError(() =>
        Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))).pipe(
          Effect.andThen(fs.remove(socketPath).pipe(Effect.ignore)),
        ),
      ),
      Effect.mapError(failed),
    );
    server.on("error", () => {
      for (const socket of sockets) socket.destroy();
    });
    servers.set(directory, { path: socketPath, server });
    return socketPath;
  });
  return CredentialShellBroker.of({ open: (directory) => lock.withPermits(1)(open(directory)) });
});
export const layer = Layer.effect(CredentialShellBroker, make);
