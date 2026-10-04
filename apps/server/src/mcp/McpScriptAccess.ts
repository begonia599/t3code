import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { CredentialVaultError, type McpScriptAccessRequest } from "@t3tools/contracts";
import { HostedMcp } from "./HostedMcp.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";
import {
  readProviderCredentialSocket,
  readProviderMcpHost,
  registerMcpSessionDisposer,
} from "./McpProviderSession.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export class McpScriptAccess extends Context.Service<
  McpScriptAccess,
  {
    readonly request: (
      scope: McpInvocationScope,
      input: McpScriptAccessRequest,
    ) => Effect.Effect<
      {
        readonly id: string;
        readonly contextFile: string;
        readonly expiresAt: string;
        readonly client: string;
        readonly service: string;
        readonly tools: ReadonlyArray<string>;
      },
      CredentialVaultError
    >;
    readonly revoke: (scope: McpInvocationScope, id: string) => Effect.Effect<boolean>;
  }
>()("t3/mcp/McpScriptAccess") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hosted = yield* HostedMcp;
  const registry = yield* McpSessionRegistry;
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const contexts = new Map<string, { owner: string; file: string }>();
  const unregister = registerMcpSessionDisposer((id) =>
    runPromise(
      Effect.gen(function* () {
        const entry = contexts.get(id);
        if (!entry) return;
        contexts.delete(id);
        yield* fs.remove(entry.file).pipe(Effect.ignore);
      }),
    ),
  );
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      unregister();
      for (const { file } of contexts.values()) yield* fs.remove(file).pipe(Effect.ignore);
      contexts.clear();
    }),
  );
  const reject = (reason: string) => new CredentialVaultError({ reason });
  const request = Effect.fn("McpScriptAccess.request")(function* (
    scope: McpInvocationScope,
    input: McpScriptAccessRequest,
  ) {
    const socket = readProviderCredentialSocket(scope.providerInstanceId);
    if (!socket || !scope.allowedFileRoots)
      return yield* reject("Script access requires this instance's Linux sandbox resource bridge.");
    const service = (yield* hosted.available(scope, input.service))[0];
    const allowedTools = service?.allowedTools;
    if (!service || (allowedTools && input.tools.some((tool) => !allowedTools.includes(tool))))
      return yield* reject("The requested service or tools are not allowed for this instance.");
    const issued = yield* registry.issueScript({
      scope,
      serviceId: input.service,
      tools: input.tools,
      ttlMs: (input.ttlMinutes ?? 15) * 60_000,
    });
    if (!issued)
      return yield* reject(
        "The parent session expired, the authorization is invalid, or this session has 32 active script grants. Revoke an unused grant and retry.",
      );
    const contextFile = path.join(path.dirname(socket), `script-${issued.sessionId}.json`);
    const endpoint = new URL(issued.endpoint);
    const mcpHost = readProviderMcpHost(scope.providerInstanceId);
    if (mcpHost) endpoint.hostname = mcpHost;
    contexts.set(issued.sessionId, { owner: scope.providerSessionId, file: contextFile });
    yield* fs
      .writeFileString(
        contextFile,
        JSON.stringify({
          version: 1,
          service: input.service,
          tools: [...new Set(input.tools)],
          endpoint: endpoint.toString(),
          authorization: issued.authorization,
          expiresAt: issued.expiresAt,
        }),
        { mode: 0o600, flag: "wx" },
      )
      .pipe(
        Effect.mapError(() => reject("Could not prepare the private script client context.")),
        Effect.onError(() => registry.revokeProviderSession(issued.sessionId)),
      );
    yield* Effect.logInfo("issued MCP script access", {
      service: input.service,
      tools: input.tools,
      instanceId: scope.providerInstanceId,
      threadId: scope.threadId,
      purpose: input.purpose,
      expiresAt: issued.expiresAt,
    });
    return {
      id: issued.sessionId,
      contextFile,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      client: "t3-resource",
      service: input.service,
      tools: [...new Set(input.tools)],
    };
  });
  return McpScriptAccess.of({
    request,
    revoke: (scope, id) =>
      Effect.gen(function* () {
        if (contexts.get(id)?.owner !== scope.providerSessionId) return false;
        yield* registry.revokeProviderSession(id);
        return true;
      }),
  });
});
export const layer = Layer.effect(McpScriptAccess, make);
