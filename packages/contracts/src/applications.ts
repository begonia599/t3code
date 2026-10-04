import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServiceName, ServiceId, ServicePort } from "./managedServices.ts";

export const ApplicationErrorCode = Schema.Literals([
  "not_configured",
  "not_allowed",
  "not_found",
  "not_supported",
  "protected_resource",
  "credential_expired",
  "invalid_manifest",
  "operation_busy",
  "build_failed",
  "start_failed",
  "health_failed",
  "route_failed",
  "internal_error",
]);
export class ApplicationError extends Schema.TaggedError<ApplicationError>()(
  "ApplicationError",
  {
    code: ApplicationErrorCode,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}
export const ApplicationPublish = Schema.Struct({
  projectRoot: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  manifestPath: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  name: Schema.optionalKey(ServiceName),
  applicationId: Schema.optionalKey(ServiceId),
  hostname: Schema.optionalKey(
    Schema.NullOr(
      Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/)),
    ),
  ),
  httpService: Schema.optionalKey(ServiceName),
  httpPort: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 })),
  ),
});
export const ApplicationReference = Schema.Struct({ applicationId: ServiceId });
export const ApplicationStatusInput = Schema.Struct({
  ...ApplicationReference.fields,
  operationId: Schema.optionalKey(ServiceId),
  wait: Schema.optionalKey(Schema.Boolean),
});
export const ApplicationReleaseInput = Schema.Struct({
  ...ApplicationReference.fields,
  releaseId: Schema.optionalKey(ServiceId),
});
export const ApplicationLogsInput = Schema.Struct({
  ...ApplicationReleaseInput.fields,
  operationId: Schema.optionalKey(ServiceId),
  kind: Schema.optionalKey(Schema.Literals(["runtime", "build", "health", "route"])),
  since: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  until: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  filter: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1000))),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
  ),
});
export const ApplicationControlInput = Schema.Struct({
  ...ApplicationReference.fields,
  action: Schema.Literals(["start", "stop", "restart"]),
});
export const ApplicationExecInput = Schema.Struct({
  ...ApplicationReference.fields,
  component: ServiceName,
  argv: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(128),
  ),
  cwd: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  stdin: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536))),
  timeoutSeconds: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 120 })),
  ),
});
export const ApplicationListInput = Schema.Struct({
  projectRoot: Schema.optionalKey(Schema.String),
});
export const ApplicationReleasesInput = Schema.Struct({
  ...ApplicationReference.fields,
  offset: Schema.optionalKey(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
  limit: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});
export const ApplicationRollbackInput = Schema.Struct({
  ...ApplicationReference.fields,
  releaseId: ServiceId,
});
export const Application = Schema.Struct({
  id: ServiceId,
  name: ServiceName,
  projectRoot: Schema.String,
  createdBy: ProviderInstanceId,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  state: Schema.Literals(["unpublished", "running", "stopped", "failed"]),
  currentReleaseId: Schema.optionalKey(ServiceId),
  latestOperationId: Schema.optionalKey(ServiceId),
  hostname: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});
export type Application = typeof Application.Type;
export const ApplicationPort = Schema.Struct({
  service: ServiceName,
  containerPort: Schema.Number,
  hostPort: ServicePort,
});
export const ApplicationRelease = Schema.Struct({
  id: ServiceId,
  applicationId: ServiceId,
  createdAt: Schema.String,
  createdBy: ProviderInstanceId,
  snapshotDigest: Schema.String,
  manifestPath: Schema.String,
  credentialNames: Schema.Array(Schema.String),
  credentialVersions: Schema.Record(Schema.String, Schema.Number),
  ports: Schema.Array(ApplicationPort),
  hostname: Schema.NullOr(Schema.String),
  endpoint: Schema.NullOr(ApplicationPort),
  composeProject: Schema.String,
  status: Schema.Literals(["prepared", "ready", "failed"]),
  components: Schema.Array(Schema.String),
  images: Schema.Record(Schema.String, Schema.String),
  sourceCommit: Schema.NullOr(Schema.String),
});
export const ApplicationOperation = Schema.Struct({
  id: ServiceId,
  applicationId: ServiceId,
  releaseId: ServiceId,
  actor: ProviderInstanceId,
  action: Schema.Literals(["publish", "rollback", "start", "stop", "restart", "unpublish"]),
  stage: Schema.Literals([
    "validating",
    "queued",
    "building",
    "starting",
    "checking-health",
    "switching-route",
    "stopping",
    "succeeded",
    "failed",
  ]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  finishedAt: Schema.optionalKey(Schema.String),
  failedStage: Schema.optionalKey(Schema.String),
  recovery: Schema.optionalKey(Schema.Literals(["unchanged", "restored", "failed"])),
  error: Schema.optionalKey(Schema.Struct({ code: ApplicationErrorCode, message: Schema.String })),
});
export const ApplicationContainer = Schema.Struct({
  component: Schema.String,
  state: Schema.String,
  health: Schema.String,
  exitCode: Schema.Number,
  restartCount: Schema.Number,
  startedAt: Schema.String,
  image: Schema.String,
  user: Schema.String,
  command: Schema.Array(Schema.String),
});
export const ApplicationResponse = Schema.Struct({
  applications: Schema.optionalKey(Schema.Array(Application)),
  application: Schema.optionalKey(Application),
  release: Schema.optionalKey(ApplicationRelease),
  releases: Schema.optionalKey(Schema.Array(ApplicationRelease)),
  operation: Schema.optionalKey(ApplicationOperation),
  containers: Schema.optionalKey(Schema.Array(ApplicationContainer)),
  runtimeAvailable: Schema.optionalKey(Schema.Boolean),
  nextOffset: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  configuration: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  logs: Schema.optionalKey(
    Schema.Struct({
      entries: Schema.Array(
        Schema.Struct({ time: Schema.String, source: Schema.String, text: Schema.String }),
      ),
      cursor: Schema.NullOr(Schema.String),
      truncated: Schema.Boolean,
      operationId: Schema.optionalKey(ServiceId),
      releaseId: Schema.optionalKey(Schema.NullOr(ServiceId)),
    }),
  ),
  execution: Schema.optionalKey(
    Schema.Struct({
      stdout: Schema.String,
      stderr: Schema.String,
      exitCode: Schema.Number,
      truncated: Schema.Boolean,
      cancelled: Schema.Boolean,
    }),
  ),
});
export type ApplicationResponse = typeof ApplicationResponse.Type;
export const ApplicationRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("list"), input: ApplicationListInput }),
  Schema.Struct({ action: Schema.Literal("publish"), input: ApplicationPublish }),
  Schema.Struct({ action: Schema.Literal("status"), input: ApplicationStatusInput }),
  Schema.Struct({ action: Schema.Literal("inspect"), input: ApplicationReleaseInput }),
  Schema.Struct({ action: Schema.Literal("logs"), input: ApplicationLogsInput }),
  Schema.Struct({ action: Schema.Literal("control"), input: ApplicationControlInput }),
  Schema.Struct({ action: Schema.Literal("exec"), input: ApplicationExecInput }),
  Schema.Struct({ action: Schema.Literal("releases"), input: ApplicationReleasesInput }),
  Schema.Struct({ action: Schema.Literal("rollback"), input: ApplicationRollbackInput }),
  Schema.Struct({ action: Schema.Literal("unpublish"), input: ApplicationReference }),
]);
export type ApplicationRequest = typeof ApplicationRequest.Type;
export const ApplicationHttpRequest = Schema.Struct({
  instanceId: ProviderInstanceId,
  request: ApplicationRequest,
});
export type ApplicationHttpRequest = typeof ApplicationHttpRequest.Type;
export const HarnessEnvironmentInfo = Schema.Struct({
  instanceId: ProviderInstanceId,
  home: Schema.String,
  workspaces: Schema.Array(Schema.String),
  executionUid: Schema.Number,
  applicationBackend: Schema.String,
  applicationRuntimeUid: Schema.Number,
  applicationLifecycle: Schema.String,
  harnessLifecycle: Schema.String,
  frameworkAccess: Schema.String,
  networkNamespace: Schema.String,
  publicAccess: Schema.String,
  privateApplicationAccess: Schema.String,
});
