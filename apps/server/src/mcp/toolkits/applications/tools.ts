import {
  ApplicationError,
  ApplicationResponse,
  ApplicationPublish,
  ApplicationReference,
  ApplicationStatusInput,
  ApplicationReleaseInput,
  ApplicationLogsInput,
  ApplicationControlInput,
  ApplicationExecInput,
  ApplicationReleasesInput,
  ApplicationRollbackInput,
  ApplicationListInput,
  HarnessEnvironmentInfo,
  ToolBindingState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { Applications } from "../../../services/Applications.ts";
const dependencies = [McpInvocationContext, Applications];
export const ApplicationsToolkit = Toolkit.make(
  Tool.make("environment_info", {
    dependencies,
    parameters: Schema.Record(Schema.String, Schema.Never),
    success: Schema.Struct({
      environment: HarnessEnvironmentInfo,
      toolBindings: Schema.Array(ToolBindingState),
    }),
    failure: ApplicationError,
    description:
      "Query this instance's actual HOME, accessible workspaces, native gh binding, network namespace and application hosting capabilities. Ordinary shell commands run as the Harness user; application publishing runs through the registered Docker Compose or systemd backend. Deployment profiles state the allowed native runtime user and resource budgets. Harness background processes end with the session or T3 shutdown; published applications survive both. The controlling T3 source/config/runtime are protected. This is metadata, not a host administration interface.",
  }).annotate(Tool.Readonly, true),
  Tool.make("application_list", {
    dependencies,
    parameters: ApplicationListInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "List T3-hosted business applications in your authorized project directories. Use returned application IDs for maintenance; an application is shared by authorized Harness instances for the same project, not restricted to its creator. Native applications additionally require an administrator-granted deployment profile for this instance. Returns available backends and deploymentProfiles. Temporary service_publish routes are a separate capability.",
  }).annotate(Tool.Readonly, true),
  Tool.make("application_publish", {
    dependencies,
    parameters: ApplicationPublish,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Publish an authorized business project. backend defaults to docker-compose; systemd requires a deploymentProfile returned by environment_info/application_list, bound to the exact project, application name and instance. Provide absolute projectRoot, project-relative manifestPath, and name for a new app or applicationId for an update. Native default application.yaml accepts command argv, optional build argv arrays/environment/credentials and a required healthcheck {type:'process'} or {type:'command',command:[...]}. Native code is /app (read-only), persistent data is /data; build runs as the normal host owner, runtime as the profile user, including root only if explicitly registered. Its filesystem/PID namespace and resource limits remain enforced. Native credentials map env names to vault names; never values. Native services need no domain/HTTP port and do not accept hostname/httpService/httpPort. No automatic public routing for native services. Docker defaults to compose.yaml. Compose must declare healthchecks, non-root runtime identity, container-only ports (e.g. '8080'), and T3-managed named volumes or relative read-only snapshot mounts. T3 snapshots source, builds immutable images, then replaces the previous version and checks health. Jobs/services survive this chat and T3 restarts. A new app without hostname has no public route. On updates, omission retains the current hostname; hostname:null removes it. Request a dedicated hostname only when the user asks for public access. Public success also requires the HTTPS URL to reach this release through Caddy. x-t3.credentials maps service env names to vault names, never values. Returns a queued operation receipt, not success; use application_status with operationId and wait:true. Failed replacement attempts restore the prior running version where possible. Persistent data/migrations are never rolled back automatically. Framework projects and host administration are unavailable.",
  })
    .annotate(Tool.Readonly, false)
    .annotate(Tool.OpenWorld, true),
  Tool.make("application_status", {
    dependencies,
    parameters: ApplicationStatusInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Inspect registered application's actual containers or systemd units, health, exit codes and restart counts, plus an operation's durable stage/error/recovery receipt. wait:true waits on that operation's change receipts for up to 25 seconds; only stage succeeded means completion, failed includes failedStage. A timeout can return a still-running stage; query again. runtimeAvailable:false means the selected runtime could not be inspected.",
  }).annotate(Tool.Readonly, true),
  Tool.make("application_inspect", {
    dependencies,
    parameters: ApplicationReleaseInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Inspect the current or selected immutable release's source snapshot digest, Git commit, actual image IDs or artifact digest, runtime identity/command and budgets, loopback ports, health checks, managed mounts and credential names/versions. Does not disclose secret values or host Docker/config paths. Use this to map production errors back to source.",
  }).annotate(Tool.Readonly, true),
  Tool.make("application_logs", {
    dependencies,
    parameters: ApplicationLogsInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Read bounded build/runtime/health/route diagnostics for a registered app, with optional RFC3339 since/until, text filter, limit (1-500) and cursor. Build/health/route logs use operationId and advance a byte cursor; runtime logs page a five-minute snapshot of the newest 2000 lines, then query without cursor for fresh logs. Credentials are redacted, truncation is explicit. No unbounded stream is sent to the model.",
  }).annotate(Tool.Readonly, true),
  Tool.make("application_control", {
    dependencies,
    parameters: ApplicationControlInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Start, stop or restart a registered app's current immutable version. Does not rebuild the developer directory. Stop removes its public route; start restores that version's route after health succeeds. An explicit stop persists across reboot: Docker unless-stopped or a disabled native unit. Native services restart after failure, with bounded retries; the process healthcheck is a liveness check, not a functional probe. Returns an operation receipt; wait through application_status.",
  }).annotate(Tool.Readonly, false),
  Tool.make("application_exec", {
    dependencies,
    parameters: ApplicationExecInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Run bounded diagnostics for one registered running business application with its configured runtime authority. Docker uses the container's non-root user; native uses a separate temporary service with the same private filesystem, data, profile user, network and limits (not the main service's PID namespace). Specify component from application_inspect, command argv, optional absolute application cwd/stdin, timeoutSeconds (1-120). Docker requires the standard timeout utility in the image; native cwd must be under /app, /data or /tmp. Returns bounded/redacted stdout/stderr, exitCode and cancellation state. Cannot execute on the host, choose another user or access Docker/systemd/T3 internals.",
  }).annotate(Tool.Readonly, false),
  Tool.make("application_releases", {
    dependencies,
    parameters: ApplicationReleasesInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Page an app's immutable release history, including prepared/failed releases, source digest and Git commit, image IDs and credential binding versions. Only ready releases can be restored.",
  }).annotate(Tool.Readonly, true),
  Tool.make("application_rollback", {
    dependencies,
    parameters: ApplicationRollbackInput,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Restore a registered app's selected ready release, images/config/credential binding version and public route after health validation. Uses the same replace strategy as publication; preserves current persistent business data. Database migrations and data are not automatically reversed. Returns a job receipt; inspect application_status for its final result.",
  }).annotate(Tool.Readonly, false),
  Tool.make("application_unpublish", {
    dependencies,
    parameters: ApplicationReference,
    success: ApplicationResponse,
    failure: ApplicationError,
    description:
      "Withdraw a registered business application: stop/remove its managed containers and remove its Caddy route. Retain source/image history and persistent data. application_control start or a new publication can restore it. Does not alter T3 itself or unrelated host services. Returns an operation receipt.",
  }).annotate(Tool.Readonly, false),
);
