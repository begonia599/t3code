import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CredentialName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
);
export const CredentialValueType = Schema.Literals(["token", "text"]);
export const CredentialUsage = Schema.Literals(["shell-and-bindings", "bindings-only"]);
export const CredentialMetadata = Schema.Struct({
  name: CredentialName,
  description: Schema.String.check(Schema.isMaxLength(1000)),
  valueType: CredentialValueType,
  length: Schema.Number,
  allowedInstances: Schema.Array(ProviderInstanceId),
  updatedAt: Schema.Number,
  usage: Schema.optionalKey(CredentialUsage),
});
export type CredentialMetadata = typeof CredentialMetadata.Type;
export const CredentialWriteInput = Schema.Struct({
  name: CredentialName,
  description: Schema.String.check(Schema.isMaxLength(1000)),
  valueType: CredentialValueType,
  value: Schema.optionalKey(
    Schema.Redacted(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536))),
  ),
  allowedInstances: Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(64)),
  requestId: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(CredentialUsage),
});
export type CredentialWriteInput = typeof CredentialWriteInput.Type;
export const CredentialInputRequest = Schema.Struct({
  id: Schema.String,
  name: CredentialName,
  description: Schema.String,
  valueType: CredentialValueType,
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(1000)),
  usage: Schema.optionalKey(CredentialUsage),
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  createdAt: Schema.Number,
});
export type CredentialInputRequest = typeof CredentialInputRequest.Type;
export const CredentialInputResult = Schema.Struct({
  request: CredentialInputRequest,
  status: Schema.Literals(["configured", "dismissed", "expired"]),
  credential: Schema.optionalKey(CredentialMetadata),
});
export type CredentialInputResult = typeof CredentialInputResult.Type;
export const CredentialGrant = Schema.Struct({
  id: Schema.String,
  names: Schema.Array(CredentialName),
  purpose: Schema.String,
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  expiresAt: Schema.Number,
});
export type CredentialGrant = typeof CredentialGrant.Type;
export const CredentialVaultSnapshot = Schema.Struct({
  credentials: Schema.Array(CredentialMetadata),
  requests: Schema.Array(CredentialInputRequest),
  grants: Schema.Array(CredentialGrant),
});
export type CredentialVaultSnapshot = typeof CredentialVaultSnapshot.Type;
export const CredentialVaultAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("delete"), name: CredentialName }),
  Schema.Struct({ action: Schema.Literal("revoke"), id: Schema.String }),
  Schema.Struct({ action: Schema.Literal("dismiss"), id: Schema.String }),
]);
export type CredentialVaultAction = typeof CredentialVaultAction.Type;
export class CredentialVaultError extends Schema.TaggedError<CredentialVaultError>()(
  "CredentialVaultError",
  { reason: Schema.String },
  { httpApiStatus: 400 },
) {
  override get message() {
    return this.reason;
  }
}
