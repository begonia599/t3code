import { AuthAccessWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { requireEnvironmentScope } from "../auth/http.ts";
import { readProviderFileRoots } from "../mcp/McpProviderSession.ts";
import { Applications } from "./Applications.ts";

export const applicationsHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "applications",
  Effect.fnUntraced(function* (handlers) {
    const applications = yield* Applications;
    return handlers.handle("request", ({ payload }) =>
      requireEnvironmentScope(AuthAccessWriteScope).pipe(
        Effect.andThen(
          applications.request(
            {
              providerInstanceId: payload.instanceId,
              allowedFileRoots: readProviderFileRoots(payload.instanceId),
            },
            payload.request,
          ),
        ),
      ),
    );
  }),
);
