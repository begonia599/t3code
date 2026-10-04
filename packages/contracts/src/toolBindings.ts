import * as Schema from "effect/Schema";
import { CredentialName } from "./credentialVault.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const GitHubRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
);
export const GitHubToolBinding = Schema.Struct({
  instanceId: ProviderInstanceId,
  enabled: Schema.Boolean,
  host: Schema.Literal("github.com"),
  account: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)),
  repositories: Schema.Array(GitHubRepository).check(Schema.isMaxLength(100)),
  source: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("github-app"),
      appId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
      installationId: Schema.String.check(Schema.isPattern(/^[0-9]+$/)),
      privateKeyCredential: CredentialName,
      access: Schema.Literals(["read", "write"]),
    }),
    Schema.Struct({ type: Schema.Literal("vault-installation-token"), credential: CredentialName }),
    Schema.Struct({ type: Schema.Literal("host-installation-token") }),
    Schema.Struct({ type: Schema.Literal("host-login") }),
  ]),
}).check(
  Schema.makeFilter((binding) =>
    binding.source.type === "host-login"
      ? binding.repositories.length === 0 ||
        "Host login retains its existing GitHub permissions; leave repositories empty."
      : binding.repositories.length > 0 || "Select at least one installation repository.",
  ),
);
export type GitHubToolBinding = typeof GitHubToolBinding.Type;
export const ToolBindingState = Schema.Struct({
  binding: GitHubToolBinding,
  status: Schema.Literals([
    "not_checked",
    "ready",
    "disabled",
    "not_allowed",
    "credential_expired",
    "not_configured",
  ]),
  message: Schema.String,
  expiresAt: Schema.optionalKey(Schema.String),
  checkedAt: Schema.optionalKey(Schema.Number),
});
export type ToolBindingState = typeof ToolBindingState.Type;
export const ToolBindingAction = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: Schema.Literals(["delete", "check", "reset"]),
});
export type ToolBindingAction = typeof ToolBindingAction.Type;
