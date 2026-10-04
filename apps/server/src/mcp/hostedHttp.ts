import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HostedMcp } from "./HostedMcp.ts";
import { McpSessionRegistry } from "./McpSessionRegistry.ts";

export const hostedMcpRouteLayer = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const manager = yield* HostedMcp;
    const registry = yield* McpSessionRegistry;
    yield* router.add(
      "*",
      "/mcp/hosted/:id",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.origin) return HttpServerResponse.empty({ status: 403 });
        const authorization = request.headers.authorization ?? "";
        const params = yield* HttpRouter.params;
        const scope = yield* registry.resolveHosted(
          authorization.startsWith("Bearer ") ? authorization.slice(7) : "",
          params.id ?? "",
        );
        if (!scope) return HttpServerResponse.empty({ status: 401 });
        const web = yield* HttpServerRequest.toWeb(request);
        return yield* manager.handle(scope, params.id ?? "", web).pipe(
          Effect.map(HttpServerResponse.fromWeb),
          Effect.catch((error) =>
            Effect.succeed(
              HttpServerResponse.jsonUnsafe(
                { error: "hosted_mcp_unavailable", reason: error.reason },
                {
                  status:
                    error.reason === "This MCP service is not available to this provider instance."
                      ? 403
                      : 503,
                },
              ),
            ),
          ),
        );
      }),
    );
  }),
);
