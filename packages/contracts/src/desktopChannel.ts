import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DesktopChannelCapabilities = Schema.StructWithRest(
  Schema.Struct({
    enabled: Schema.Boolean,
    exec: Schema.optional(
      Schema.Struct({
        version: TrimmedNonEmptyString,
        shells: Schema.Array(TrimmedNonEmptyString),
      }),
    ),
    mcp: Schema.optional(
      Schema.Struct({
        version: TrimmedNonEmptyString,
        servers: Schema.Array(
          Schema.Struct({
            id: TrimmedNonEmptyString,
            name: TrimmedNonEmptyString,
            status: TrimmedNonEmptyString,
            tools: Schema.Array(
              Schema.Struct({
                name: TrimmedNonEmptyString,
                description: Schema.optional(Schema.String),
                inputSchema: Schema.Unknown,
              }),
            ),
          }),
        ),
      }),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type DesktopChannelCapabilities = typeof DesktopChannelCapabilities.Type;

export const DesktopChannelHost = Schema.Struct({
  hostId: Schema.String.check(Schema.isUUID()),
  hostName: TrimmedNonEmptyString,
  platform: Schema.Literals(["win32", "darwin", "linux"]),
  appVersion: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  capabilities: DesktopChannelCapabilities,
});
export type DesktopChannelHost = typeof DesktopChannelHost.Type;

export const DesktopChannelRequestContext = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  provider: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(Schema.String),
});
export type DesktopChannelRequestContext = typeof DesktopChannelRequestContext.Type;

export const DesktopChannelRequest = Schema.Struct({
  requestId: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  input: Schema.Unknown,
  timeoutMs: Schema.Int.check(Schema.isGreaterThan(0)),
  context: DesktopChannelRequestContext,
});
export type DesktopChannelRequest = typeof DesktopChannelRequest.Type;

export const DesktopChannelStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("request"), ...DesktopChannelRequest.fields }),
  Schema.Struct({ type: Schema.Literal("cancel"), requestId: TrimmedNonEmptyString }),
]);
export type DesktopChannelStreamEvent = typeof DesktopChannelStreamEvent.Type;

const connectionFields = {
  hostId: DesktopChannelHost.fields.hostId,
  connectionId: TrimmedNonEmptyString,
};
const requestFields = { ...connectionFields, requestId: TrimmedNonEmptyString };

export const DesktopChannelResponse = Schema.Union([
  Schema.Struct({ ...requestFields, ok: Schema.Literal(true), result: Schema.Unknown }),
  Schema.Struct({
    ...requestFields,
    ok: Schema.Literal(false),
    error: Schema.Struct({ code: TrimmedNonEmptyString, message: Schema.String }),
  }),
]);
export type DesktopChannelResponse = typeof DesktopChannelResponse.Type;

/** One acknowledged batch. Hosts send consecutive seq values starting at zero. */
export const DesktopChannelEmit = Schema.Struct({
  ...requestFields,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  events: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(["stdout", "stderr", "progress", "notification"]),
      data: Schema.String,
    }),
  ),
});
export type DesktopChannelEmit = typeof DesktopChannelEmit.Type;

export const DesktopChannelUpdateCapabilities = Schema.Struct({
  ...connectionFields,
  capabilities: DesktopChannelCapabilities,
});
export type DesktopChannelUpdateCapabilities = typeof DesktopChannelUpdateCapabilities.Type;

export const DesktopChannelErrorCode = Schema.Literals([
  "HOST_OFFLINE",
  "HOST_AMBIGUOUS",
  "HOST_DISABLED",
  "HOST_DISCONNECTED",
  "HOST_REPLACED",
  "HOST_BUSY",
  "TIMEOUT",
  "CANCELLED",
  "HOST_ERROR",
  "STALE_CONNECTION",
]);
export type DesktopChannelErrorCode = typeof DesktopChannelErrorCode.Type;

export class DesktopChannelError extends Schema.TaggedError<DesktopChannelError>()(
  "DesktopChannelError",
  {
    code: DesktopChannelErrorCode,
    message: Schema.String,
    hostId: Schema.optional(Schema.String),
    requestId: Schema.optional(Schema.String),
    remoteCode: Schema.optional(Schema.String),
  },
) {}
