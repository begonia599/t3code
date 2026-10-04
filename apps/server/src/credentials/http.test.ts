import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/unstable/http";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import * as Config from "../config.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as Vault from "./CredentialVault.ts";
import * as Hosted from "../mcp/HostedMcp.ts";
import { credentialVaultHttpApiLayer } from "./http.ts";

class TestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.credentialVault) {}
const authentication = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("resource-user"),
        subject: "resource-user",
        method: "browser-session-cookie",
        scopes: new Set(
          request.headers.authorization === "Bearer fixture-admin"
            ? [AuthAccessWriteScope]
            : request.headers.authorization === "Bearer fixture-operator"
              ? [AuthOrchestrationOperateScope]
              : [],
        ),
      }),
    ),
  ),
);
const routes = HttpApiBuilder.layer(TestApi).pipe(
  Layer.provide(credentialVaultHttpApiLayer),
  Layer.provide(authentication),
  Layer.provide(Hosted.layer),
  Layer.provide(Vault.layer),
  Layer.provide(SecretStore.layer),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "t3-vault-http-" })),
  Layer.provide(HttpPlatform.layer),
  Layer.provide(Etag.layerWeak),
  Layer.provide(NodeServices.layer),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const post = (payload: unknown, authorization = "Bearer fixture-admin") =>
  new Request("http://t3.test/api/credential-vault/write", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: encode(payload),
  });

it.effect(
  "writes values through private HTTP, requires administrator scopes, and returns no value even for invalid input",
  () =>
    Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) =>
        Effect.tryPromise(async () => {
          const payload = {
            name: "APP_KEY",
            value: "fixture-private-value",
            valueType: "token",
            description: "",
            allowedInstances: ["codex"],
          };
          const denied = await web.handler(post(payload, "Bearer fixture-regular-client"));
          expect(denied.status).toBe(403);
          expect(await denied.text()).not.toContain(payload.value);
          const operatorWithoutPendingRequest = await web.handler(
            post({ ...payload, requestId: "missing-request" }, "Bearer fixture-operator"),
          );
          expect(operatorWithoutPendingRequest.status).toBe(400);
          expect(await operatorWithoutPendingRequest.text()).not.toContain(payload.value);
          const written = await web.handler(post(payload));
          expect(written.status).toBe(200);
          const text = await written.text();
          expect(text).not.toContain(payload.value);
          expect(text).toContain("APP_KEY");
          for (const invalid of [
            { ...payload, name: "invalid name" },
            { ...payload, value: { private: payload.value } },
            { ...payload, value: payload.value + "\0" },
          ]) {
            const response = await web.handler(post(invalid));
            expect(response.status).toBe(400);
            expect(await response.text()).not.toContain(payload.value);
          }
        }),
      (web) => Effect.promise(() => web.dispose()),
    ),
);
