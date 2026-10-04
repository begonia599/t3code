import * as Schema from "effect/Schema";
import { CredentialName, CredentialVaultSnapshot } from "./credentialVault.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const HostedMcpId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/));
const binding = Schema.Struct({
  credential: CredentialName,
  prefix: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
});
const toolName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]{1,128}$/));
const text = Schema.String.check(Schema.isMaxLength(4096));
const fields = Schema.Array(
  Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/)),
).check(Schema.isMaxLength(32));
export const HostedMcpExposure = Schema.Struct({
  instructions: Schema.optionalKey(text),
  allowedTools: Schema.optionalKey(Schema.Array(toolName).check(Schema.isMaxLength(128))),
  toolDescriptions: Schema.optionalKey(Schema.Record(toolName, text)),
  parameterDescriptions: Schema.optionalKey(
    Schema.Record(toolName, Schema.Record(Schema.String, text)),
  ),
  omittedResultProperties: Schema.optionalKey(Schema.Record(toolName, fields)),
  fileInputs: Schema.optionalKey(Schema.Record(toolName, fields)),
});
export type HostedMcpExposure = typeof HostedMcpExposure.Type;
export const HostedMcpConfig = Schema.Struct({
  id: HostedMcpId,
  label: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  enabled: Schema.Boolean,
  allowedInstances: Schema.Array(ProviderInstanceId).check(Schema.isMaxLength(64)),
  exposure: Schema.optionalKey(HostedMcpExposure),
  adapter: Schema.optionalKey(
    Schema.Struct({
      kind: Schema.Literal("nai"),
      artifactDirectory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
    }),
  ),
  transport: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("stdio"),
      command: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      args: Schema.Array(Schema.String).check(Schema.isMaxLength(128)),
      cwd: Schema.optionalKey(Schema.String),
      environment: Schema.Record(Schema.String, binding),
    }),
    Schema.Struct({
      type: Schema.Literal("http"),
      url: Schema.String,
      headers: Schema.Record(Schema.String, binding),
    }),
  ]),
});
export type HostedMcpConfig = typeof HostedMcpConfig.Type;
export const McpScriptAccessRequest = Schema.Struct({
  service: HostedMcpId,
  tools: Schema.Array(toolName).check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  purpose: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  ttlMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 60 })),
  ),
});
export type McpScriptAccessRequest = typeof McpScriptAccessRequest.Type;
export const HostedMcpState = Schema.Struct({
  config: HostedMcpConfig,
  connections: Schema.Number,
  status: Schema.Literals(["stopped", "running", "error"]),
});
export const HostedMcpAction = Schema.Struct({
  id: HostedMcpId,
  action: Schema.Literals(["delete", "restart", "stop"]),
});
export type HostedMcpAction = typeof HostedMcpAction.Type;
export const ResourceSnapshot = Schema.Struct({
  vault: CredentialVaultSnapshot,
  mcp: Schema.Array(HostedMcpState),
  tools: Schema.optionalKey(Schema.Array(ToolBindingState)),
});
export type ResourceSnapshot = typeof ResourceSnapshot.Type;
import { ToolBindingState } from "./toolBindings.ts";
