import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { Applications } from "../../../services/Applications.ts";
import { ToolBindings } from "../../../credentials/ToolBindings.ts";
import { ApplicationsToolkit } from "./tools.ts";
import type { ApplicationRequest } from "@t3tools/contracts";
export const make = Effect.gen(function* () {
  const apps = yield* Applications;
  const bindings = yield* ToolBindings;
  const request = (input: ApplicationRequest) =>
    Effect.flatMap(McpInvocationContext, (scope) => apps.request(scope, input));
  return ApplicationsToolkit.of({
    application_request_deployment: (input) => request({ action: "deployment-propose", input }),
    application_deployment_requests: (input) => request({ action: "deployment-requests", input }),
    application_cancel_deployment_request: (input) =>
      request({ action: "deployment-cancel", input }),
    environment_info: () =>
      Effect.flatMap(McpInvocationContext, (scope) =>
        Effect.gen(function* () {
          return {
            environment: yield* apps.environment(scope),
            toolBindings: (yield* bindings.snapshot).filter(
              (state) => state.binding.instanceId === scope.providerInstanceId,
            ),
          };
        }),
      ),
    application_list: (input) => request({ action: "list", input }),
    application_publish: (input) => request({ action: "publish", input }),
    application_status: (input) => request({ action: "status", input }),
    application_inspect: (input) => request({ action: "inspect", input }),
    application_logs: (input) => request({ action: "logs", input }),
    application_control: (input) => request({ action: "control", input }),
    application_exec: (input) => request({ action: "exec", input }),
    application_releases: (input) => request({ action: "releases", input }),
    application_rollback: (input) => request({ action: "rollback", input }),
    application_unpublish: (input) => request({ action: "unpublish", input }),
  });
});
export const ApplicationsToolkitHandlersLive = ApplicationsToolkit.toLayer(make);
