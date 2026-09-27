// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AuthGitHubMobileFinishRequest,
  type AuthGitHubMobileFinishResult,
  AuthStandardClientScopes,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

const CALLBACK_PATH = "/api/auth/github/callback";
const COOKIE_NAME = "t3_github_oauth_state";
const FLOW_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_FLOWS = 1024;
const MOBILE_REDIRECTS = new Set([
  "t3code://github-auth",
  "t3code-preview://github-auth",
  "t3code-dev://github-auth",
]);

interface PendingFlow {
  readonly verifier: string;
  readonly expiresAt: number;
  readonly mobileRedirect?: string;
  readonly mobileNonce?: string;
  readonly mobileChallenge?: string;
}

interface CompletedMobileFlow {
  readonly challenge: string;
  readonly expiresAt: number;
  readonly subject: string;
  readonly label: string;
}

function randomUrlSafe(bytes = 32): string {
  return NodeCrypto.randomBytes(bytes).toString("base64url");
}

function stateCookie(state: string, secure: boolean): string {
  return `${COOKIE_NAME}=${state}; HttpOnly; SameSite=Lax; Path=${CALLBACK_PATH}; Max-Age=300${secure ? "; Secure" : ""}`;
}

function expiredStateCookie(secure: boolean): string {
  return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=${CALLBACK_PATH}; Max-Age=0${secure ? "; Secure" : ""}`;
}

function responseHeaders(cookie?: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    ...(cookie ? { "set-cookie": cookie } : {}),
  };
}

function reject(message: string, status: number, cookie?: string) {
  return HttpServerResponse.text(message, { status, headers: responseHeaders(cookie) });
}

function redirect(url: string, cookie?: string) {
  return HttpServerResponse.redirect(url, { status: 302, headers: responseHeaders(cookie) });
}

function readStateCookie(cookieHeader: string | undefined): string | undefined {
  return cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1);
}

const authenticatedGitHubUser = Effect.fn("auth.github.user")(function* (input: {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly callbackUrl: string;
  readonly verifier: string;
}) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const tokenResponse = yield* HttpClientRequest.post(
    "https://github.com/login/oauth/access_token",
  ).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    HttpClientRequest.bodyUrlParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.callbackUrl,
      code_verifier: input.verifier,
    }),
    client.execute,
    Effect.timeout(Duration.seconds(10)),
  );
  const token = (yield* tokenResponse.json) as { access_token?: unknown };
  if (typeof token.access_token !== "string" || !token.access_token) return null;

  const userResponse = yield* HttpClientRequest.get("https://api.github.com/user").pipe(
    HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
    HttpClientRequest.setHeader("authorization", `Bearer ${token.access_token}`),
    HttpClientRequest.setHeader("x-github-api-version", "2022-11-28"),
    client.execute,
    Effect.timeout(Duration.seconds(10)),
  );
  const user = (yield* userResponse.json) as { id?: unknown; login?: unknown };
  return Number.isSafeInteger(user.id) && typeof user.login === "string"
    ? { id: user.id as number, login: user.login }
    : null;
});

/** Optional GitHub identity bootstrap; the regular T3 session still controls access. */
export const githubOAuthRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { githubOAuth } = yield* ServerConfig.ServerConfig;
    if (!githubOAuth) return Layer.empty;

    const pending = new Map<string, PendingFlow>();
    const completedMobile = new Map<string, CompletedMobileFlow>();
    const callbackUrl = new URL(CALLBACK_PATH, githubOAuth.origin).toString();
    const secure = githubOAuth.origin.protocol === "https:";

    const start = HttpRouter.add(
      "GET",
      "/api/auth/github/start",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const requestUrl = HttpServerRequest.toURL(request);
        if (requestUrl._tag === "None" || requestUrl.value.host !== githubOAuth.origin.host) {
          return reject("Invalid GitHub sign-in origin.", 400);
        }
        const mobileRedirect = requestUrl.value.searchParams.get("mobile_redirect") ?? undefined;
        const mobileNonce = requestUrl.value.searchParams.get("mobile_nonce") ?? undefined;
        const mobileChallenge = requestUrl.value.searchParams.get("mobile_challenge") ?? undefined;
        if (
          (mobileRedirect !== undefined && !MOBILE_REDIRECTS.has(mobileRedirect)) ||
          (mobileRedirect !== undefined &&
            (mobileNonce === undefined ||
              !/^[A-Za-z0-9_-]{32,128}$/.test(mobileNonce) ||
              mobileChallenge === undefined ||
              !/^[a-f0-9]{64}$/.test(mobileChallenge))) ||
          (mobileRedirect === undefined &&
            (mobileNonce !== undefined || mobileChallenge !== undefined))
        ) {
          return reject("Invalid mobile sign-in request.", 400);
        }

        const now = yield* Clock.currentTimeMillis;
        for (const [key, flow] of pending) {
          if (flow.expiresAt < now) pending.delete(key);
        }
        for (const [key, flow] of completedMobile) {
          if (flow.expiresAt < now) completedMobile.delete(key);
        }
        if (pending.size + completedMobile.size >= MAX_PENDING_FLOWS) {
          return reject("Too many GitHub sign-in attempts. Please try again later.", 429);
        }
        const state = randomUrlSafe();
        const verifier = randomUrlSafe();
        const challenge = NodeCrypto.createHash("sha256").update(verifier).digest("base64url");
        pending.set(state, {
          verifier,
          expiresAt: now + FLOW_TTL_MS,
          ...(mobileRedirect ? { mobileRedirect } : {}),
          ...(mobileNonce ? { mobileNonce } : {}),
          ...(mobileChallenge ? { mobileChallenge } : {}),
        });
        const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
        authorizationUrl.search = new URLSearchParams({
          client_id: githubOAuth.clientId,
          redirect_uri: callbackUrl,
          state,
          code_challenge: challenge,
          code_challenge_method: "S256",
        }).toString();
        return redirect(authorizationUrl.toString(), stateCookie(state, secure));
      }),
    );

    const callback = HttpRouter.add(
      "GET",
      CALLBACK_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const requestUrl = HttpServerRequest.toURL(request);
        const state =
          requestUrl._tag === "Some" ? requestUrl.value.searchParams.get("state") : null;
        const code = requestUrl._tag === "Some" ? requestUrl.value.searchParams.get("code") : null;
        const clearCookie = expiredStateCookie(secure);
        if (
          requestUrl._tag === "None" ||
          requestUrl.value.host !== githubOAuth.origin.host ||
          !state ||
          !code ||
          readStateCookie(request.headers.cookie) !== state
        ) {
          return reject(
            "GitHub sign-in could not be verified. Please try again.",
            400,
            clearCookie,
          );
        }
        const flow = pending.get(state);
        pending.delete(state);
        if (!flow || flow.expiresAt < (yield* Clock.currentTimeMillis)) {
          return reject("GitHub sign-in expired. Please try again.", 400, clearCookie);
        }

        const user = yield* authenticatedGitHubUser({
          clientId: githubOAuth.clientId,
          clientSecret: Redacted.value(githubOAuth.clientSecret),
          code,
          callbackUrl,
          verifier: flow.verifier,
        }).pipe(Effect.orElseSucceed(() => null));
        if (!user || !githubOAuth.allowedUserIds.has(user.id)) {
          return reject(
            "This GitHub account is not allowed to access this environment.",
            403,
            clearCookie,
          );
        }

        const subject = `github:${user.id}`;
        const label = `GitHub @${user.login}`;
        if (flow.mobileRedirect && flow.mobileNonce && flow.mobileChallenge) {
          completedMobile.set(state, {
            challenge: flow.mobileChallenge,
            expiresAt: (yield* Clock.currentTimeMillis) + 2 * 60 * 1000,
            subject,
            label,
          });
          const mobileUrl = new URL(flow.mobileRedirect);
          mobileUrl.searchParams.set("host", githubOAuth.origin.origin);
          mobileUrl.searchParams.set("flow", state);
          mobileUrl.searchParams.set("nonce", flow.mobileNonce);
          return redirect(mobileUrl.toString(), clearCookie);
        }
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* environmentAuth.createPairingLink({
          scopes: AuthStandardClientScopes,
          subject,
          label,
          ttl: Duration.minutes(2),
        });
        const pairUrl = new URL("/pair", githubOAuth.origin);
        pairUrl.hash = new URLSearchParams({ token: issued.credential }).toString();
        return redirect(pairUrl.toString(), clearCookie);
      }),
    );

    const mobileFinish = HttpRouter.add(
      "POST",
      "/api/auth/github/mobile/finish",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const input = yield* request.json.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(AuthGitHubMobileFinishRequest)),
          Effect.orElseSucceed(() => null),
        );
        if (
          !input ||
          !/^[A-Za-z0-9_-]{43}$/.test(input.flow) ||
          !/^[a-f0-9]{64}$/.test(input.verifier)
        ) {
          return reject("Invalid mobile sign-in request.", 400);
        }
        const flow = completedMobile.get(input.flow);
        if (!flow || flow.expiresAt < (yield* Clock.currentTimeMillis)) {
          completedMobile.delete(input.flow);
          return reject("GitHub sign-in expired. Please try again.", 400);
        }
        const expected = Buffer.from(flow.challenge, "hex");
        const actual = NodeCrypto.createHash("sha256").update(input.verifier).digest();
        if (!NodeCrypto.timingSafeEqual(expected, actual)) {
          return reject("Invalid mobile sign-in proof.", 403);
        }
        completedMobile.delete(input.flow);
        const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const issued = yield* environmentAuth.createPairingLink({
          scopes: AuthStandardClientScopes,
          subject: flow.subject,
          label: flow.label,
          ttl: Duration.minutes(2),
        });
        return HttpServerResponse.jsonUnsafe(
          { credential: issued.credential } satisfies AuthGitHubMobileFinishResult,
          { headers: responseHeaders() },
        );
      }),
    );
    return Layer.mergeAll(start, callback, mobileFinish);
  }),
);
