import {
  CredentialName,
  CredentialMetadata,
  CredentialInputResult,
  CredentialGrant,
  CredentialValueType,
  CredentialUsage,
  CredentialVaultError,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { CredentialVault } from "../../../credentials/CredentialVault.ts";

const dependencies = [McpInvocationContext, CredentialVault];
export const CredentialsToolkit = Toolkit.make(
  Tool.make("credential_list", {
    description:
      "List variables the T3 user has made available to this provider instance. Returns names, types, lengths and descriptions, never values. Check this before asking the user for a credential.",
    parameters: Schema.Struct({ name: Schema.optionalKey(CredentialName) }),
    success: Schema.Struct({ credentials: Schema.Array(CredentialMetadata) }),
    failure: CredentialVaultError,
    dependencies,
  }).annotate(Tool.Readonly, true),
  Tool.make("credential_request_input", {
    description:
      "Ask the user to enter a variable directly into the T3 library. T3 shows a private form and waits up to 15 minutes; your turn continues when the form is saved or dismissed. Only metadata/status enter the conversation, never the value. For GitHub App private keys use valueType:text and usage:bindings-only, which cannot be granted to shell commands. For temporary shell variables use usage:shell-and-bindings (default), then credential_request_use after configuration. Native gh with a preconfigured tool binding needs no manual grant.",
    parameters: Schema.Struct({
      name: CredentialName,
      description: Schema.String.check(Schema.isMaxLength(1000)),
      valueType: CredentialValueType,
      purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
      usage: Schema.optionalKey(CredentialUsage),
    }),
    success: CredentialInputResult,
    failure: CredentialVaultError,
    dependencies,
  }).annotate(Tool.Readonly, false),
  Tool.make("credential_request_use", {
    description:
      "Authorize listed variables for native shell commands in this provider session for 15 minutes. Requires a configured T3 Linux shell bridge and prior user permission for this instance. After allowed=true, use normal shell variable references such as $OPENAI_API_KEY with curl or scripts. Values are supplied by T3 when the shell starts, never returned by this tool. Request again after expiry. Model inference login credentials are unchanged.",
    parameters: Schema.Struct({
      names: Schema.Array(CredentialName).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
      purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
    }),
    success: Schema.Struct({ allowed: Schema.Literal(true), grant: CredentialGrant }),
    failure: CredentialVaultError,
    dependencies,
  }).annotate(Tool.Readonly, false),
  Tool.make("credential_revoke_use", {
    description:
      "Revoke one credential grant from this provider session. New shells stop receiving these variables. Already-running processes retain the environment they were started with.",
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.Struct({ revoked: Schema.Boolean }),
    failure: CredentialVaultError,
    dependencies,
  }).annotate(Tool.Readonly, false),
);
