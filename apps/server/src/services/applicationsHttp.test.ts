import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { registerProviderFileRoots } from "../mcp/McpProviderSession.ts";
import { Applications, type ApplicationScope } from "./Applications.ts";
import { applicationsHttpApiLayer } from "./http.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.applications) {}
const authentication = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("app-test-user"),
        subject: "app-test-user",
        method: "browser-session-cookie",
        scopes: new Set(
          request.headers.authorization === "Bearer fixture-admin" ? [AuthAccessWriteScope] : [],
        ),
      }),
    ),
  ),
);
it.effect(
  "only administrators can manage applications and roots come from the trusted instance profile",
  () => {
    const calls: Array<ApplicationScope> = [];
    const approvals: Array<ApplicationScope> = [];
    const applications = Layer.succeed(Applications, {
      deploymentAdmin: (scope) =>
        Effect.sync(() => {
          approvals.push(scope);
          return { deploymentRequests: [] };
        }),
      request: (scope) =>
        Effect.sync(() => {
          calls.push(scope);
          return { applications: [] };
        }),
      environment: () => Effect.die("unused"),
    });
    const routes = HttpApiBuilder.layer(TestApi).pipe(
      Layer.provide(applicationsHttpApiLayer),
      Layer.provide(authentication),
      Layer.provide(applications),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    return Effect.acquireUseRelease(
      Effect.sync(() => ({
        web: HttpRouter.toWebHandler(routes, { disableLogger: true }),
        unregister: registerProviderFileRoots(ProviderInstanceId.make("codex"), ["/projects/blog"]),
      })),
      ({ web }) =>
        Effect.tryPromise(async () => {
          const post = (token: string) =>
            new Request("http://t3.test/api/applications/request", {
              method: "POST",
              headers: { authorization: token, "content-type": "application/json" },
              body: JSON.stringify({
                instanceId: "codex",
                roots: ["/"],
                request: { action: "list", input: {} },
              }),
            });
          const denied = await web.handler(post("Bearer fixture-regular-client"));
          expect(denied.status).toBe(403);
          expect(calls).toEqual([]);
          const allowed = await web.handler(post("Bearer fixture-admin"));
          expect(allowed.status).toBe(200);
          expect(calls).toEqual([
            { providerInstanceId: "codex", allowedFileRoots: ["/projects/blog"] },
          ]);
          const review = (token: string, path: string) =>
            new Request(`http://t3.test/api/applications/${path}`, {
              method: "POST",
              headers: { authorization: token, "content-type": "application/json" },
              body: JSON.stringify({
                instanceId: "codex",
                roots: ["/"],
                request: {
                  action: "approve",
                  input: { requestId: "a".repeat(32), revision: "b".repeat(64), confirmRoot: true },
                },
              }),
            });
          expect(
            (await web.handler(review("Bearer fixture-regular-client", "deployment-admin"))).status,
          ).toBe(403);
          expect(approvals).toEqual([]);
          expect((await web.handler(review("Bearer fixture-admin", "request"))).status).toBe(400);
          expect(approvals).toEqual([]);
          expect(
            (await web.handler(review("Bearer fixture-admin", "deployment-admin"))).status,
          ).toBe(200);
          expect(approvals).toEqual([
            { providerInstanceId: "codex", allowedFileRoots: ["/projects/blog"] },
          ]);
        }),
      ({ web, unregister }) =>
        Effect.promise(async () => {
          unregister();
          await web.dispose();
        }),
    );
  },
);
