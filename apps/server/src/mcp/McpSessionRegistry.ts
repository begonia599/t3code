import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpProviderSession from "./McpProviderSession.ts";
import { publishCredentialSession } from "../credentials/CredentialBridgeState.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpInvocationContext.McpCapability>;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSession.McpProviderSessionConfig;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential>;
  readonly resolve: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly resolveCredential: (
    rawToken: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly resolveHosted: (
    rawToken: string,
    serviceId: string,
  ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  readonly issueScript: (input: {
    readonly scope: McpInvocationContext.McpInvocationScope;
    readonly serviceId: string;
    readonly tools: ReadonlyArray<string>;
    readonly ttlMs: number;
  }) => Effect.Effect<
    | {
        readonly authorization: string;
        readonly endpoint: string;
        readonly sessionId: string;
        readonly expiresAt: number;
      }
    | undefined
  >;
  /**
   * Records a sign of life for every credential bound to `threadId`. Provider
   * turns call this so that a session which is plainly alive keeps its
   * credential even when it goes a long time without touching an MCP tool.
   */
  readonly touch: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/McpSessionRegistry") {}

interface CredentialRecord {
  readonly purpose: "mcp" | "shell" | "script";
  readonly parentSessionId?: string;
  readonly expiresAt?: number;
  readonly tokenHash: string;
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly lastAliveAt: number;
}

interface RegistryState {
  readonly records: ReadonlyMap<string, CredentialRecord>;
}

export interface McpSessionRegistryOptions {
  readonly livenessWindowMs?: number;
  readonly now?: () => number;
}

/**
 * How long a credential outlives the last sign of life from its provider
 * session.
 *
 * Liveness is refreshed both by MCP traffic and by `touch` on every provider
 * turn, so a session that is still doing work never expires no matter how long
 * it goes between browser tool calls. This window therefore only bounds
 * credentials whose session died without a clean stop — the normal paths
 * (`stopSession`, `stopAll`) revoke eagerly and do not wait for it.
 *
 * The bound matters because `/mcp` is mounted outside the environment auth
 * stack and is reachable on whatever host the server binds to, so this token is
 * the only thing guarding the `t3-code` toolkits on a remote-reachable server.
 */
const DEFAULT_LIVENESS_WINDOW_MS = 24 * 60 * 60 * 1_000;

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

// A wildcard bind is reachable on loopback, which is where the provider
// subprocesses run; anything else is announced as the address it bound.
const getHttpMcpEndpointHost = (address: NetAddress.IpAddress): string =>
  NetAddress.isUnspecified(address)
    ? "127.0.0.1"
    : NetAddress.formatUrlHostString(NetAddress.formatIp(address));

const makeWithOptions = Effect.fn("McpSessionRegistry.make")(function* (
  options: McpSessionRegistryOptions = {},
) {
  const crypto = yield* Crypto.Crypto;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const httpServer = yield* HttpServer.HttpServer;
  const state = yield* SynchronizedRef.make<RegistryState>({ records: new Map() });
  const currentTimeMillis = options.now ? Effect.sync(options.now) : Clock.currentTimeMillis;
  const livenessWindowMs = options.livenessWindowMs ?? DEFAULT_LIVENESS_WINDOW_MS;
  const endpoint = NetAddress.isInetAddress(httpServer.address)
    ? `http://${getHttpMcpEndpointHost(httpServer.address.address)}:${httpServer.address.port}/mcp`
    : "http://127.0.0.1/mcp";

  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(bytesToHex), Effect.orDie);

  const pruneDead = (records: ReadonlyMap<string, CredentialRecord>, timestamp: number) => {
    const alive = (record: CredentialRecord) =>
      timestamp - record.lastAliveAt <= livenessWindowMs &&
      (record.expiresAt === undefined || record.expiresAt > timestamp);
    const parents = new Set(
      [...records.values()]
        .filter((record) => record.purpose === "mcp" && alive(record))
        .map((record) => record.scope.providerSessionId),
    );
    const keep = (record: CredentialRecord) =>
      alive(record) &&
      (record.parentSessionId === undefined || parents.has(record.parentSessionId));
    for (const record of records.values())
      if (!keep(record)) void McpProviderSession.disposeMcpSession(record.scope.providerSessionId);
    const next = new Map(Array.from(records).filter(([, record]) => keep(record)));
    return next.size === records.size ? records : next;
  };

  const issue: McpSessionRegistryShape["issue"] = Effect.fn("McpSessionRegistry.issue")(
    function* (request) {
      const issuedAt = yield* currentTimeMillis;
      const providerSessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const rawToken = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const tokenHash = yield* hashToken(rawToken);
      const bridgeToken = yield* crypto
        .randomBytes(32)
        .pipe(Effect.map(tokenFromBytes), Effect.orDie);
      const bridgeHash = yield* hashToken(bridgeToken);
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId,
        threadId: ThreadId.make(request.threadId),
        providerSessionId,
        providerInstanceId: ProviderInstanceId.make(request.providerInstanceId),
        capabilities: new Set<McpInvocationContext.McpCapability>([
          "pull-requests",
          ...request.capabilities,
        ]),
        issuedAt,
        allowedFileRoots: McpProviderSession.readProviderFileRoots(request.providerInstanceId),
      };
      yield* SynchronizedRef.update(state, ({ records }) => {
        const next = new Map(pruneDead(records, issuedAt));
        next.set(tokenHash, { purpose: "mcp", tokenHash, scope, lastAliveAt: issuedAt });
        next.set(bridgeHash, {
          purpose: "shell",
          tokenHash: bridgeHash,
          scope,
          lastAliveAt: issuedAt,
        });
        return { records: next };
      });
      yield* Effect.promise(() => publishCredentialSession(scope, `Bearer ${bridgeToken}`));
      return {
        config: {
          environmentId,
          threadId: scope.threadId,
          providerSessionId,
          providerInstanceId: scope.providerInstanceId,
          endpoint,
          authorizationHeader: `Bearer ${rawToken}`,
          credentialBridgeAuthorization: `Bearer ${bridgeToken}`,
          capabilities: scope.capabilities,
        },
      };
    },
  );

  const resolveFor = Effect.fn("McpSessionRegistry.resolveFor")(function* (
    rawToken: string,
    accepts: (record: CredentialRecord) => boolean,
  ) {
    if (rawToken.length === 0) return undefined;
    const tokenHash = yield* hashToken(rawToken);
    const timestamp = yield* currentTimeMillis;
    return yield* SynchronizedRef.modify(state, ({ records }) => {
      const current = pruneDead(records, timestamp);
      const record = current.get(tokenHash);
      if (!record || !accepts(record)) return [undefined, { records: current }] as const;
      if (
        record.scope.allowedFileRoots !==
        McpProviderSession.readProviderFileRoots(record.scope.providerInstanceId)
      ) {
        void McpProviderSession.disposeMcpSession(record.scope.providerSessionId);
        const next = new Map(current);
        next.delete(tokenHash);
        return [undefined, { records: next }] as const;
      }
      const next = new Map(current);
      next.set(tokenHash, { ...record, lastAliveAt: timestamp });
      return [record.scope, { records: next }] as const;
    });
  });
  const resolve: McpSessionRegistryShape["resolve"] = (token) =>
    resolveFor(token, (record) => record.purpose === "mcp");
  const resolveCredential: McpSessionRegistryShape["resolveCredential"] = (token) =>
    resolveFor(token, (record) => record.purpose === "shell");
  const resolveHosted: McpSessionRegistryShape["resolveHosted"] = (token, serviceId) =>
    resolveFor(
      token,
      (record) =>
        record.purpose === "mcp" ||
        (record.purpose === "script" && record.scope.script?.serviceId === serviceId),
    );
  const issueScript: McpSessionRegistryShape["issueScript"] = Effect.fn(
    "McpSessionRegistry.issueScript",
  )(function* (input) {
    const now = yield* currentTimeMillis;
    const parent = yield* SynchronizedRef.get(state).pipe(
      Effect.map(({ records }) =>
        [...pruneDead(records, now).values()].find(
          (record) =>
            record.purpose === "mcp" &&
            record.scope.providerSessionId === input.scope.providerSessionId,
        ),
      ),
    );
    if (
      !parent ||
      input.scope.script ||
      input.tools.length === 0 ||
      input.ttlMs < 1_000 ||
      input.ttlMs > 60 * 60_000
    )
      return undefined;
    const sessionId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
    const token = yield* crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);
    const tokenHash = yield* hashToken(token);
    const expiresAt = now + input.ttlMs;
    const scope: McpInvocationContext.McpInvocationScope = {
      ...parent.scope,
      providerSessionId: sessionId,
      capabilities: new Set(),
      script: { serviceId: input.serviceId, tools: new Set(input.tools) },
      issuedAt: now,
    };
    const inserted = yield* SynchronizedRef.modify(state, ({ records }) => {
      const next = new Map(pruneDead(records, now));
      const parentAlive = [...next.values()].some(
        (record) =>
          record.purpose === "mcp" &&
          record.scope.providerSessionId === parent.scope.providerSessionId,
      );
      const count = [...next.values()].filter(
        (record) => record.parentSessionId === parent.scope.providerSessionId,
      ).length;
      if (!parentAlive || count >= 32) return [false, { records: next }] as const;
      next.set(tokenHash, {
        purpose: "script",
        parentSessionId: parent.scope.providerSessionId,
        tokenHash,
        scope,
        lastAliveAt: now,
        expiresAt,
      });
      return [true, { records: next }] as const;
    });
    if (!inserted) return undefined;
    return {
      authorization: `Bearer ${token}`,
      endpoint: new URL(`/mcp/hosted/${input.serviceId}`, endpoint).toString(),
      sessionId,
      expiresAt,
    };
  });

  const touch: McpSessionRegistryShape["touch"] = Effect.fn("McpSessionRegistry.touch")(
    function* (threadId) {
      const timestamp = yield* currentTimeMillis;
      yield* SynchronizedRef.update(state, ({ records }) => {
        const current = pruneDead(records, timestamp);
        const next = new Map(current);
        for (const [tokenHash, record] of current) {
          if (record.scope.threadId === threadId) {
            next.set(tokenHash, { ...record, lastAliveAt: timestamp });
          }
        }
        return { records: next };
      });
    },
  );

  const revokeWhere = (predicate: (record: CredentialRecord) => boolean) =>
    SynchronizedRef.modify(
      state,
      ({ records }) =>
        [
          [...records.values()].filter(predicate).map((record) => record.scope.providerSessionId),
          { records: new Map(Array.from(records).filter(([, record]) => !predicate(record))) },
        ] as const,
    ).pipe(
      Effect.flatMap((ids) =>
        Effect.promise(() => Promise.all(ids.map(McpProviderSession.disposeMcpSession))),
      ),
      Effect.asVoid,
    );

  return McpSessionRegistry.of({
    issue,
    resolve,
    resolveCredential,
    resolveHosted,
    issueScript,
    touch,
    revokeProviderSession: Effect.fn("McpSessionRegistry.revokeProviderSession")(
      function* (providerSessionId) {
        yield* revokeWhere(
          (record) =>
            record.scope.providerSessionId === providerSessionId ||
            record.parentSessionId === providerSessionId,
        );
      },
    ),
    revokeThread: Effect.fn("McpSessionRegistry.revokeThread")(function* (threadId) {
      yield* revokeWhere((record) => record.scope.threadId === threadId);
    }),
    revokeAll: revokeWhere(() => true),
  });
});

let activeMcpSessionRegistry: McpSessionRegistryShape | undefined;

const make = Effect.acquireRelease(
  makeWithOptions().pipe(
    Effect.tap((registry) =>
      Effect.sync(() => {
        activeMcpSessionRegistry = registry;
      }),
    ),
  ),
  (registry) =>
    Effect.sync(() => {
      if (activeMcpSessionRegistry === registry) {
        activeMcpSessionRegistry = undefined;
      }
    }),
);

export const layer = Layer.effect(McpSessionRegistry, make);

export const issueActiveMcpCredential = (
  request: McpCredentialRequest,
): Effect.Effect<McpIssuedCredential | undefined> =>
  activeMcpSessionRegistry
    ? activeMcpSessionRegistry
        .revokeThread(request.threadId)
        .pipe(Effect.andThen(activeMcpSessionRegistry.issue(request)))
    : Effect.undefined;

/**
 * Refreshes the liveness of a thread's MCP credential. Called on every provider
 * turn so an active session is never mistaken for an abandoned one.
 */
export const touchActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.touch(threadId) : Effect.void;

export const revokeActiveMcpThread = (threadId: ThreadId): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeThread(threadId) : Effect.void;

export const revokeAllActiveMcpCredentials = (): Effect.Effect<void> =>
  activeMcpSessionRegistry ? activeMcpSessionRegistry.revokeAll : Effect.void;

/** Exposed for tests. */
export const __testing = {
  make: makeWithOptions,
};
