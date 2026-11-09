import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import * as Logger from "effect/Logger";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

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

const makeRegistry = (now: () => number, httpServer = fakeHttpServer, stateDir?: string) =>
  McpSessionRegistry.__testing
    .make({
      now,
      ...(stateDir ? { stateDir } : {}),
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
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

it.effect(
  "always grants file downloads and pull requests and gates browser and device access independently",
  () =>
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

      expect(yield* capabilitiesOf(withPreview)).toEqual([
        "file-downloads",
        "preview",
        "pull-requests",
      ]);
      expect(yield* capabilitiesOf(withoutPreview)).toEqual(["file-downloads", "pull-requests"]);
      expect(yield* capabilitiesOf(withDevice)).toEqual([
        "device",
        "file-downloads",
        "pull-requests",
      ]);
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

for (const revoke of ["thread", "provider", "all", "expiry", "startup"] as const) {
  it.effect(`removes win credentials on ${revoke}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win-credentials-" });
        let timestamp = 1000;
        const registry = yield* makeRegistry(() => timestamp, fakeHttpServer, stateDir);
        const issued = yield* registry.issue({
          threadId: ThreadId.make("win-thread"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["win"]),
        });
        const env = issued.config.agentWinEnvironment!;
        const file = env.T3_WIN_CREDENTIAL_FILE!;
        expect(env.T3_WIN_ENDPOINT).toBe("http://127.0.0.1:43123/agent-win/v1");
        expect(env.PATH).toBe(`${stateDir}/agent-win/bin`);
        expect(yield* fs.readFileString(file)).toBe(issued.config.authorizationHeader.slice(7));
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);
        expect((yield* fs.stat(`${stateDir}/agent-win/credentials`)).mode & 0o777).toBe(0o700);
        if (revoke === "thread") yield* registry.revokeThread(issued.config.threadId);
        if (revoke === "provider")
          yield* registry.revokeProviderSession(issued.config.providerSessionId);
        if (revoke === "all") yield* registry.revokeAll;
        if (revoke === "expiry") {
          timestamp += 101;
          expect(
            yield* registry.resolve(issued.config.authorizationHeader.slice(7)),
          ).toBeUndefined();
        }
        if (revoke === "startup") {
          yield* fs.makeDirectory(`${stateDir}/agent-win/credentials/stale`);
          yield* fs.writeFileString(`${stateDir}/agent-win/credentials/stale/nested.token`, "old");
          yield* makeRegistry(() => timestamp, fakeHttpServer, stateDir);
          expect(yield* fs.exists(`${stateDir}/agent-win/credentials`)).toBe(false);
        }
        expect(yield* fs.exists(file)).toBe(false);
        if (revoke !== "startup")
          expect(
            yield* registry.resolve(issued.config.authorizationHeader.slice(7)),
          ).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.effect("leaves the existing session environment unchanged with win disabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-no-win-" });
      const registry = yield* makeRegistry(() => 1000, fakeHttpServer, stateDir);
      const issued = yield* registry.issue({
        threadId: ThreadId.make("no-win"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: new Set(),
      });
      expect(issued.config.agentWinEnvironment).toBeUndefined();
      expect(yield* fs.exists(`${stateDir}/agent-win`)).toBe(false);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("keeps other capabilities and the credential when win credential writes fail", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-win-failed-" });
      const warnings: unknown[] = [];
      const failingFs = FileSystem.FileSystem.of({
        ...fs,
        writeFileString: (file, content, options) =>
          fs.writeFileString(file, content, options).pipe(
            Effect.andThen(
              file.endsWith(".token")
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "writeFileString",
                      pathOrDescriptor: file,
                    }),
                  )
                : Effect.void,
            ),
          ),
      });
      const registry = yield* McpSessionRegistry.__testing
        .make({ stateDir, now: () => 1000 })
        .pipe(
          Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
          Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
          Effect.provideService(FileSystem.FileSystem, failingFs),
        );
      const issued = yield* registry
        .issue({
          threadId: ThreadId.make("win-failed"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["preview", "device", "win"]),
        })
        .pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([
              Logger.make(({ message }) => {
                warnings.push(message);
              }),
            ]),
          ),
        );
      expect(issued.config.agentWinEnvironment).toBeUndefined();
      expect([...issued.config.capabilities].sort()).toEqual([
        "device",
        "file-downloads",
        "preview",
        "pull-requests",
      ]);
      const resolved = yield* registry.resolve(issued.config.authorizationHeader.slice(7));
      expect(resolved?.threadId).toBe("win-failed");
      expect([...resolved!.capabilities].sort()).toEqual([
        "device",
        "file-downloads",
        "preview",
        "pull-requests",
      ]);
      expect(yield* fs.readDirectory(`${stateDir}/agent-win/credentials`)).toEqual([]);
      expect(warnings).toHaveLength(1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
