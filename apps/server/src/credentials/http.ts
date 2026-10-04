import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  CredentialVaultError,
  type CredentialVaultSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { requireEnvironmentScope } from "../auth/http.ts";
import { CredentialVault } from "./CredentialVault.ts";
import { HostedMcp } from "../mcp/HostedMcp.ts";
import { ToolBindings } from "./ToolBindings.ts";

export const credentialVaultHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "credentialVault",
  Effect.fnUntraced(function* (handlers) {
    const vault = yield* CredentialVault;
    const mcp = yield* HostedMcp;
    const tools = yield* Effect.serviceOption(ToolBindings);
    const privateResponse = (
      session: { scopes: ReadonlySet<string> },
      snapshot: CredentialVaultSnapshot,
    ): CredentialVaultSnapshot =>
      session.scopes.has(AuthAccessWriteScope)
        ? snapshot
        : { credentials: [], requests: [], grants: [] };
    // Values use dedicated HTTP requests, outside replayable orchestration events.
    return handlers
      .handle("writeTool", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(
          Effect.andThen(
            Option.isSome(tools)
              ? tools.value.write(payload)
              : Effect.fail(new CredentialVaultError({ reason: "Tool bindings are unavailable." })),
          ),
        ),
      )
      .handle("actionTool", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(
          Effect.andThen(
            Option.isSome(tools)
              ? tools.value.action(payload)
              : Effect.fail(new CredentialVaultError({ reason: "Tool bindings are unavailable." })),
          ),
        ),
      )
      .handle("writeMcp", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(Effect.andThen(mcp.write(payload))),
      )
      .handle("actionMcp", ({ payload }) =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(Effect.andThen(mcp.action(payload))),
      )
      .handle("snapshot", () =>
        requireEnvironmentScope(AuthAccessWriteScope).pipe(Effect.andThen(vault.snapshot)),
      )
      .handle("write", ({ payload }) =>
        requireEnvironmentScope(
          payload.requestId ? AuthOrchestrationOperateScope : AuthAccessWriteScope,
        ).pipe(
          Effect.flatMap((session) =>
            vault.write(payload).pipe(Effect.map((snapshot) => privateResponse(session, snapshot))),
          ),
        ),
      )
      .handle("action", ({ payload }) =>
        requireEnvironmentScope(
          payload.action === "dismiss" ? AuthOrchestrationOperateScope : AuthAccessWriteScope,
        ).pipe(
          Effect.flatMap((session) =>
            vault
              .action(payload)
              .pipe(Effect.map((snapshot) => privateResponse(session, snapshot))),
          ),
        ),
      );
  }),
);
