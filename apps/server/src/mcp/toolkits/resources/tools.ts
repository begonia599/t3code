import { Tool, Toolkit } from "effect/unstable/ai";
import * as Schema from "effect/Schema";
import { McpScriptAccessRequest, HostedMcpId, CredentialVaultError } from "@t3tools/contracts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export const ResourcesToolkit = Toolkit.make(
  Tool.make("mcp_list_services", {
    dependencies: [McpInvocationContext],
    description:
      "List hosted MCP services allowed for this instance. Use the native MCP tools directly; for batch scripts, request restricted access with mcp_request_script_access. This list does not expose backend credentials or host administration endpoints.",
    parameters: Schema.Struct({ service: Schema.optionalKey(HostedMcpId) }),
    success: Schema.Struct({
      services: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          label: Schema.String,
          allowedTools: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
      scriptClient: Schema.String,
    }),
  }),
  Tool.make("mcp_request_script_access", {
    dependencies: [McpInvocationContext],
    failure: CredentialVaultError,
    description:
      "Authorize a script to call selected tools of one hosted MCP service for 15 minutes by default (maximum 60). Returns a private context file and the t3-resource client name, not an authentication value. Run: t3-resource mcp tools --context CONTEXT_FILE; t3-resource mcp call TOOL_NAME --context CONTEXT_FILE --json-file REQUEST_JSON. The shell must have network permission to reach T3; this grant does not override the harness's native network policy. Business credentials stay in T3. The script cannot use T3's credential or service-management tools with this authorization.",
    parameters: McpScriptAccessRequest,
    success: Schema.Struct({
      id: Schema.String,
      contextFile: Schema.String,
      expiresAt: Schema.String,
      client: Schema.String,
      service: Schema.String,
      tools: Schema.Array(Schema.String),
    }),
  }),
  Tool.make("mcp_revoke_script_access", {
    dependencies: [McpInvocationContext],
    description:
      "Revoke a script authorization issued in this session and close its hosted MCP clients.",
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.Struct({ revoked: Schema.Boolean }),
  }),
);
