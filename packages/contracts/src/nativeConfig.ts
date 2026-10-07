import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const NativeConfigTarget = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type NativeConfigTarget = typeof NativeConfigTarget.Type;

export const NativeConfigFile = Schema.Struct({
  path: Schema.String,
  scope: Schema.Literals(["user", "project", "local", "managed", "memory"]),
  kind: Schema.Literals(["settings", "instructions", "rules", "skill", "memory"]),
  format: Schema.Literals(["toml", "json", "markdown"]),
  exists: Schema.Boolean,
  writable: Schema.Boolean,
  problem: Schema.NullOr(Schema.String),
});
export type NativeConfigFile = typeof NativeConfigFile.Type;

export const NativeConfigList = Schema.Struct({
  driver: Schema.Literals(["codex", "claudeAgent"]),
  homePath: Schema.String,
  files: Schema.Array(NativeConfigFile),
  truncated: Schema.Boolean,
  environmentOverrides: Schema.Array(Schema.String),
  hasLaunchOverrides: Schema.Boolean,
});
export type NativeConfigList = typeof NativeConfigList.Type;

export const NativeConfigReadInput = Schema.Struct({
  ...NativeConfigTarget.fields,
  path: TrimmedNonEmptyString,
});
export type NativeConfigReadInput = typeof NativeConfigReadInput.Type;

export const NativeConfigDocument = Schema.Struct({
  file: NativeConfigFile,
  resolvedPath: Schema.String,
  revision: Schema.String,
  content: Schema.String,
});
export type NativeConfigDocument = typeof NativeConfigDocument.Type;

export const NativeConfigWriteInput = Schema.Struct({
  ...NativeConfigReadInput.fields,
  revision: TrimmedNonEmptyString,
  content: Schema.String.check(Schema.isMaxLength(256 * 1024)),
});
export type NativeConfigWriteInput = typeof NativeConfigWriteInput.Type;

export const NativeConfigWriteResult = Schema.Struct({
  document: NativeConfigDocument,
  undoToken: Schema.String,
});
export type NativeConfigWriteResult = typeof NativeConfigWriteResult.Type;

export const NativeConfigUndoInput = Schema.Struct({ undoToken: TrimmedNonEmptyString });
export type NativeConfigUndoInput = typeof NativeConfigUndoInput.Type;

export class NativeConfigError extends Schema.TaggedError<NativeConfigError>()(
  "NativeConfigError",
  {
    reason: Schema.Literals([
      "unsupported",
      "unavailable",
      "conflict",
      "invalid",
      "readonly",
      "expired",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}
