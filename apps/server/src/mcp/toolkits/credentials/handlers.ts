import * as Effect from "effect/Effect";
import { CredentialsToolkit } from "./tools.ts";
import { CredentialVault } from "../../../credentials/CredentialVault.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const make = Effect.gen(function* () {
  const vault = yield* CredentialVault;
  return CredentialsToolkit.of({
    credential_list: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext;
        const credentials = yield* vault.list(scope);
        return {
          credentials: input.name
            ? credentials.filter((entry) => entry.name === input.name)
            : credentials,
        };
      }),
    credential_request_input: (input) =>
      Effect.flatMap(McpInvocationContext, (scope) => vault.requestInputAndWait(scope, input)),
    credential_request_use: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext;
        return {
          allowed: true as const,
          grant: yield* vault.requestUse(scope, input.names, input.purpose),
        };
      }),
    credential_revoke_use: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext;
        return { revoked: yield* vault.revokeUse(scope, input.id) };
      }),
  });
});
export const CredentialsToolkitHandlersLive = CredentialsToolkit.toLayer(make);
