// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { HttpClient, HttpClientResponse, HttpRouter, HttpPlatform } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { githubOAuthRouteLayer } from "./GitHubOAuth.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const origin = "https://code.example.test";
const callback = `${origin}/api/auth/github/callback`;

const configLayer = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      githubOAuth: {
        clientId: "test-client",
        clientSecret: Redacted.make("test-secret"),
        origin: new URL(origin),
        allowedUserIds: new Set([42]),
      },
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-github-auth-test-" })));

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.identityLayer),
  Layer.provide(configLayer),
);

const githubUserId = { value: 42 };
const githubClient = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.endsWith("/login/oauth/access_token")
        ? Response.json({ access_token: "github-token" })
        : Response.json({ id: githubUserId.value, login: "allowed-user" }),
    ),
  ),
);

const routesLayer = Layer.mergeAll(
  githubOAuthRouteLayer,
  HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(authHttpApiLayer),
    Layer.provide(environmentAuthenticatedAuthLayer),
  ),
).pipe(
  Layer.provideMerge(environmentAuthLayer),
  Layer.provide(configLayer),
  Layer.provide(Layer.succeed(HttpClient.HttpClient, githubClient)),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const startRequest = (params = "") =>
  new Request(`${origin}/api/auth/github/start${params}`, {
    headers: { host: "code.example.test" },
  });

it.effect("accepts an allowed GitHub identity and exchanges it for a T3 browser session", () =>
  Effect.gen(function* () {
    githubUserId.value = 42;
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by this route."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      Context.add(HttpClient.HttpClient, githubClient),
    );

    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.tryPromise(async () => {
          const start = await handler(startRequest(), requestContext);
          expect(start.status).toBe(302);
          const authorizeUrl = new URL(start.headers.get("location")!);
          expect(authorizeUrl.origin).toBe("https://github.com");
          expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
          expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(callback);
          const state = authorizeUrl.searchParams.get("state")!;
          const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;

          const wrongState = await handler(
            new Request(`${callback}?state=wrong&code=code`, {
              headers: { host: "code.example.test", cookie },
            }),
            requestContext,
          );
          expect(wrongState.status).toBe(400);

          const completed = await handler(
            new Request(`${callback}?state=${state}&code=code`, {
              headers: { host: "code.example.test", cookie },
            }),
            requestContext,
          );
          expect(completed.status).toBe(302);
          const pairUrl = new URL(completed.headers.get("location")!);
          expect(pairUrl.pathname).toBe("/pair");
          const credential = new URLSearchParams(pairUrl.hash.slice(1)).get("token");
          expect(credential).toBeTruthy();

          const session = await handler(
            new Request(`${origin}/api/auth/browser-session`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: await Response.json({ credential }).text(),
            }),
            requestContext,
          );
          expect(session.status).toBe(200);
          expect(session.headers.get("set-cookie")).toContain("HttpOnly");
          expect(await session.json()).toMatchObject({ authenticated: true });

          const replay = await handler(
            new Request(`${callback}?state=${state}&code=code`, {
              headers: { host: "code.example.test", cookie },
            }),
            requestContext,
          );
          expect(replay.status).toBe(400);

          const mobileNonce = "a".repeat(64);
          const mobileVerifier = "b".repeat(64);
          const mobileStart = await handler(
            startRequest(
              `?${new URLSearchParams({
                mobile_redirect: "t3code-preview://github-auth",
                mobile_nonce: mobileNonce,
                mobile_challenge: NodeCrypto.createHash("sha256")
                  .update(mobileVerifier)
                  .digest("hex"),
              })}`,
            ),
            requestContext,
          );
          expect(mobileStart.status).toBe(302);
          const mobileState = new URL(mobileStart.headers.get("location")!).searchParams.get(
            "state",
          )!;
          const mobileCookie = mobileStart.headers.get("set-cookie")!.split(";", 1)[0]!;
          const mobileCallback = await handler(
            new Request(`${callback}?state=${mobileState}&code=mobile-code`, {
              headers: { host: "code.example.test", cookie: mobileCookie },
            }),
            requestContext,
          );
          expect(mobileCallback.status).toBe(302);
          const mobileUrl = new URL(mobileCallback.headers.get("location")!);
          expect(mobileUrl.protocol).toBe("t3code-preview:");
          expect(mobileUrl.searchParams.get("host")).toBe(origin);
          expect(mobileUrl.searchParams.get("nonce")).toBe(mobileNonce);
          expect(mobileUrl.searchParams.has("token")).toBe(false);
          const mobileFlow = mobileUrl.searchParams.get("flow")!;
          const wrongProof = await handler(
            new Request(`${origin}/api/auth/github/mobile/finish`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: await Response.json({ flow: mobileFlow, verifier: "c".repeat(64) }).text(),
            }),
            requestContext,
          );
          expect(wrongProof.status).toBe(403);
          const mobileFinish = await handler(
            new Request(`${origin}/api/auth/github/mobile/finish`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: await Response.json({ flow: mobileFlow, verifier: mobileVerifier }).text(),
            }),
            requestContext,
          );
          expect(mobileFinish.status).toBe(200);
          const mobileCredential = ((await mobileFinish.json()) as { credential: string })
            .credential;
          const mobileSession = await handler(
            new Request(`${origin}/oauth/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: mobileCredential,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
              }),
            }),
            requestContext,
          );
          expect(mobileSession.status).toBe(200);
          expect(await mobileSession.json()).toMatchObject({ token_type: "Bearer" });

          const finishReplay = await handler(
            new Request(`${origin}/api/auth/github/mobile/finish`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: await Response.json({ flow: mobileFlow, verifier: mobileVerifier }).text(),
            }),
            requestContext,
          );
          expect(finishReplay.status).toBe(400);

          const invalidMobileReturn = await handler(
            startRequest(
              "?mobile_redirect=https%3A%2F%2Fevil.example%2F&mobile_nonce=" + mobileNonce,
            ),
            requestContext,
          );
          expect(invalidMobileReturn.status).toBe(400);
        }),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("rejects an account outside the allowed GitHub IDs", () =>
  Effect.gen(function* () {
    githubUserId.value = 99;
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by this route."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      Context.add(HttpClient.HttpClient, githubClient),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routesLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.tryPromise(async () => {
          const start = await handler(startRequest(), requestContext);
          const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
          const cookie = start.headers.get("set-cookie")!.split(";", 1)[0]!;
          const completed = await handler(
            new Request(`${callback}?state=${state}&code=code`, {
              headers: { host: "code.example.test", cookie },
            }),
            requestContext,
          );
          expect(completed.status).toBe(403);
          expect(completed.headers.get("location")).toBeNull();
        }),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
