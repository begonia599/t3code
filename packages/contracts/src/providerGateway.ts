import * as Schema from "effect/Schema";
import { ProviderInstanceEnvironment, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderGatewayConfig } from "./gatewayConfig.ts";

export const ProviderGatewayProbeInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  gateway: ProviderGatewayConfig,
  environment: ProviderInstanceEnvironment,
  action: Schema.Literals(["models", "test"]),
});
export type ProviderGatewayProbeInput = typeof ProviderGatewayProbeInput.Type;

export const ProviderGatewayProbeResult = Schema.Struct({
  models: Schema.Array(Schema.String),
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.Literals(["models", "stream", "tools"]),
      ok: Schema.Boolean,
      detail: Schema.String,
    }),
  ),
});
export type ProviderGatewayProbeResult = typeof ProviderGatewayProbeResult.Type;

export class ProviderGatewayError extends Schema.TaggedError<ProviderGatewayError>()(
  "ProviderGatewayError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
