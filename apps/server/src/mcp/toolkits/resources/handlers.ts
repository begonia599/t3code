import * as Effect from "effect/Effect";
import { HostedMcp } from "../../HostedMcp.ts";
import { McpScriptAccess } from "../../McpScriptAccess.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ResourcesToolkit } from "./tools.ts";

export const make = Effect.gen(function* () {
  const hosted = yield* HostedMcp;
  const scripts = yield* McpScriptAccess;
  return ResourcesToolkit.of({
    mcp_list_services: (input) =>
      Effect.flatMap(McpInvocationContext, (scope) =>
        hosted
          .available(scope, input.service)
          .pipe(Effect.map((services) => ({ services, scriptClient: "t3-resource" }))),
      ),
    mcp_request_script_access: (input) =>
      Effect.flatMap(McpInvocationContext, (scope) => scripts.request(scope, input)),
    mcp_revoke_script_access: (input) =>
      Effect.flatMap(McpInvocationContext, (scope) =>
        scripts.revoke(scope, input.id).pipe(Effect.map((revoked) => ({ revoked }))),
      ),
  });
});
export const ResourcesToolkitHandlersLive = ResourcesToolkit.toLayer(make);
