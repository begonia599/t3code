import * as Schema from "effect/Schema";

const ModelId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const HeaderName = Schema.String.check(
  Schema.isPattern(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
  Schema.isMaxLength(128),
);

/** Credentials are references to the instance's existing secret-backed environment. */
export const ProviderGatewayConfig = Schema.Struct({
  enabled: Schema.Boolean,
  protocol: Schema.Literals(["anthropic", "responses"]),
  baseUrl: Schema.String.check(Schema.isMaxLength(2048)),
  auth: Schema.Literals(["bearer", "api-key"]),
  model: ModelId,
  models: Schema.Array(ModelId).check(Schema.isMaxLength(200)),
  roles: Schema.Struct({
    opus: Schema.optionalKey(ModelId),
    sonnet: Schema.optionalKey(ModelId),
    haiku: Schema.optionalKey(ModelId),
    subagent: Schema.optionalKey(ModelId),
  }),
  headers: Schema.Array(
    Schema.Struct({
      name: HeaderName,
      variable: Schema.String.check(Schema.isPattern(/^T3_GATEWAY_HEADER_[0-9]+$/)),
    }),
  ).check(Schema.isMaxLength(20)),
});
export type ProviderGatewayConfig = typeof ProviderGatewayConfig.Type;
