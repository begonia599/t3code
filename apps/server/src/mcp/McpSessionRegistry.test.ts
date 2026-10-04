import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { registerProviderFileRoots } from "./McpProviderSession.ts";

const environmentId = EnvironmentId.make("environment-1");
const makeFakeHttpServer = (hostname: string, port = 43123) =>
  HttpServer.HttpServer.of({
    address: NetAddress.inetAddressFromIpStringUnsafe(hostname, port),
    serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
  });
const fakeHttpServer = makeFakeHttpServer("127.0.0.1");
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(environmentId),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number, httpServer = fakeHttpServer) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("invalidates a sandbox credential when its mounted view changes or closes", () =>
  Effect.gen(function* () {
    const id = ProviderInstanceId.make("sandbox-view-account");
    const roots = ["/srv/project", "/srv/private/account"];
    const closeOriginal = registerProviderFileRoots(id, roots);
    let closeReplacement: (() => void) | undefined;
    try {
      const registry = yield* makeRegistry(() => 1_000);
      const issued = yield* registry.issue({
        threadId: ThreadId.make("sandbox-view-thread"),
        providerInstanceId: id,
        capabilities: new Set(),
      });
      const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
      expect((yield* registry.resolve(token))?.allowedFileRoots).toBe(roots);
      closeReplacement = registerProviderFileRoots(id, ["/srv/different-project"]);
      closeOriginal();
      expect(yield* registry.resolve(token)).toBeUndefined();
      const next = yield* registry.issue({
        threadId: ThreadId.make("sandbox-next-thread"),
        providerInstanceId: id,
        capabilities: new Set(),
      });
      const nextToken = next.config.authorizationHeader.replace(/^Bearer\s+/, "");
      closeReplacement();
      expect(yield* registry.resolve(nextToken)).toBeUndefined();
    } finally {
      closeOriginal();
      closeReplacement?.();
    }
  }),
);

it.effect("stores only a token hash, resolves the bearer token, and revokes by thread", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-1");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    expect(issued.config.endpoint).toBe("http://127.0.0.1:43123/mcp");
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    expect(token.length).toBeGreaterThan(20);

    const resolved = yield* registry.resolve(token);
    expect(resolved?.threadId).toBe(threadId);

    yield* registry.revokeThread(threadId);
    expect(yield* registry.resolve(token)).toBeUndefined();

    timestamp += 2_000;
  }),
);

it.effect("separates shell and MCP authorization, restricts scripts and revokes children", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("script-thread"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const native = issued.config.authorizationHeader.slice(7);
    const shell = issued.config.credentialBridgeAuthorization!.slice(7);
    expect(native).not.toBe(shell);
    expect(yield* registry.resolve(shell)).toBeUndefined();
    expect(yield* registry.resolveHosted(shell, "nai")).toBeUndefined();
    expect(yield* registry.resolveCredential(native)).toBeUndefined();
    const scope = (yield* registry.resolve(native))!;
    expect((yield* registry.resolveCredential(shell))?.providerSessionId).toBe(
      scope.providerSessionId,
    );
    const script = (yield* registry.issueScript({
      scope,
      serviceId: "nai",
      tools: ["identity"],
      ttlMs: 1_000,
    }))!;
    const token = script.authorization.slice(7);
    expect(yield* registry.resolve(token)).toBeUndefined();
    expect(yield* registry.resolveCredential(token)).toBeUndefined();
    expect(yield* registry.resolveHosted(token, "other")).toBeUndefined();
    expect((yield* registry.resolveHosted(token, "nai"))?.script?.tools.has("identity")).toBe(true);
    const active = (yield* registry.issueScript({
      scope,
      serviceId: "nai",
      tools: ["identity"],
      ttlMs: 2_000,
    }))!;
    for (let index = 0; index < 10; index++) {
      timestamp += 100;
      yield* registry.touch(scope.threadId);
    }
    expect(yield* registry.resolveHosted(token, "nai")).toBeUndefined();
    yield* registry.revokeProviderSession(scope.providerSessionId);
    expect(yield* registry.resolveHosted(active.authorization.slice(7), "nai")).toBeUndefined();
    expect(yield* registry.resolveCredential(shell)).toBeUndefined();
  }),
);

it.effect("always grants pull-requests and gates browser and device access independently", () =>
  Effect.gen(function* () {
    const registry = yield* makeRegistry(() => 1_000);
    const withPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const withoutPreview = yield* registry.issue({
      threadId: ThreadId.make("thread-no-preview"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(),
    });
    const withDevice = yield* registry.issue({
      threadId: ThreadId.make("thread-device"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["device"]),
    });
    const capabilitiesOf = (issued: typeof withPreview) =>
      registry
        .resolve(issued.config.authorizationHeader.replace(/^Bearer\s+/, ""))
        .pipe(Effect.map((scope) => [...(scope?.capabilities ?? [])].sort()));

    expect(yield* capabilitiesOf(withPreview)).toEqual(["preview", "pull-requests"]);
    expect(yield* capabilitiesOf(withoutPreview)).toEqual(["pull-requests"]);
    expect(yield* capabilitiesOf(withDevice)).toEqual(["device", "pull-requests"]);
  }),
);

it.effect("builds MCP endpoints from the bound server host", () =>
  Effect.gen(function* () {
    const cases = [
      ["100.64.0.40", "http://100.64.0.40:43123/mcp"],
      ["0.0.0.0", "http://127.0.0.1:43123/mcp"],
      ["::", "http://127.0.0.1:43123/mcp"],
      ["::1", "http://[::1]:43123/mcp"],
      ["127.0.0.1", "http://127.0.0.1:43123/mcp"],
    ] as const;

    for (const [hostname, expectedEndpoint] of cases) {
      const registry = yield* makeRegistry(() => 1_000, makeFakeHttpServer(hostname));
      const issued = yield* registry.issue({
        threadId: ThreadId.make(`thread-${hostname}`),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(["preview"]),
      });
      expect(issued.config.endpoint).toBe(expectedEndpoint);
    }
  }),
);

it.effect("expires credentials once their session stops showing signs of life", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-2"),
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");
    timestamp += 101;
    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);

it.effect("keeps a credential alive across turns that never touch an MCP tool", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const threadId = ThreadId.make("thread-3");
    const issued = yield* registry.issue({
      threadId,
      providerInstanceId: ProviderInstanceId.make("claude"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    // Well past the liveness window in total, but each turn reports in before
    // it lapses — this is the long-session case that used to lose the toolkit.
    for (let turn = 0; turn < 10; turn += 1) {
      timestamp += 99;
      yield* registry.touch(threadId);
    }

    expect((yield* registry.resolve(token))?.threadId).toBe(threadId);
  }),
);

it.effect("does not keep credentials of other threads alive", () =>
  Effect.gen(function* () {
    let timestamp = 1_000;
    const registry = yield* makeRegistry(() => timestamp);
    const issued = yield* registry.issue({
      threadId: ThreadId.make("thread-4"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["preview"]),
    });
    const token = issued.config.authorizationHeader.replace(/^Bearer\s+/, "");

    timestamp += 99;
    yield* registry.touch(ThreadId.make("thread-unrelated"));
    timestamp += 2;

    expect(yield* registry.resolve(token)).toBeUndefined();
  }),
);
