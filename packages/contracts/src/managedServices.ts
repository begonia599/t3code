import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ServiceName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/));
export const ServiceId = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/));
export const ServicePort = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1024, maximum: 65535 }),
);
export const ServicePublish = Schema.Struct({
  name: ServiceName,
  port: ServicePort,
  hostname: Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/)),
});
export const ServiceShare = Schema.Struct({
  port: ServicePort,
  targetInstanceId: ProviderInstanceId,
  durationMinutes: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1440 })),
  ),
});
export const ServicePublication = Schema.Struct({
  id: ServiceId,
  profile: Schema.String,
  instanceId: ProviderInstanceId,
  name: ServiceName,
  port: ServicePort,
  hostname: Schema.String,
  pathPrefix: Schema.String,
  privateUrl: Schema.String,
  url: Schema.String,
});
export const ServiceAccessGrant = Schema.Struct({
  id: ServiceId,
  profile: Schema.String,
  targetProfile: Schema.String,
  instanceId: ProviderInstanceId,
  targetInstanceId: ProviderInstanceId,
  port: ServicePort,
  privateUrl: Schema.String,
  expiresAt: Schema.Number,
});
export const ServiceNetworkState = Schema.Struct({
  instanceId: ProviderInstanceId,
  privateIp: Schema.String,
  instances: Schema.Array(
    Schema.Struct({ instanceId: ProviderInstanceId, profile: Schema.String }),
  ),
  publications: Schema.Array(ServicePublication),
  shares: Schema.Array(ServiceAccessGrant),
});
export type ServiceNetworkState = typeof ServiceNetworkState.Type;
export type ServiceNetworkAction = "list" | "publish" | "unpublish" | "share" | "unshare";
export class ServiceNetworkError extends Schema.TaggedError<ServiceNetworkError>()(
  "ServiceNetworkError",
  { message: Schema.String },
) {}
