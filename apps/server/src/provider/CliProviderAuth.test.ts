import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { makeCliProviderAuth } from "./CliProviderAuth.ts";
import type { SpawnProviderLogin } from "./ProviderLoginProcess.ts";
import {
  isCliAuthorizationCode,
  readCliLoginInteraction,
  supportsClaudeBrowserLogin,
  supportsGrokBrowserLogin,
  type LoginCli,
} from "./cliProviderAuthSupport.ts";

const instanceId = ProviderInstanceId.make("native-login-test");
const claudeUrl =
  "https://claude.ai/oauth/authorize?client_id=fixture&state=state-fixture&code_challenge=challenge-fixture";
const grokUrl = "https://auth.x.ai/device";
const messages = {
  claude: `Opening browser to sign in…\nIf the browser didn't open, visit: ${claudeUrl}\nPaste code here if prompted > `,
  grok: `To sign in, open this URL in your browser:\n\n  ${grokUrl}\n\nThen enter this code:\n\n  ABCD-EFGH\n\nWaiting for authorization...\n`,
};

const makeHarness = Effect.fnUntraced(function* (
  provider: LoginCli,
  options: {
    enabled?: boolean;
    verify?: boolean;
    logoutFails?: boolean;
    hangLogout?: boolean;
  } = {},
) {
  const output = yield* Queue.unbounded<string, Cause.Done>();
  const exited = yield* Deferred.make<number>();
  const calls: Array<{ args: ReadonlyArray<string>; terminal: boolean }> = [];
  const input: string[] = [];
  let closed = 0;
  let refreshed = 0;
  const logoutStarted = yield* Deferred.make<void>();
  const spawn: SpawnProviderLogin = (args, terminal = false) =>
    Effect.gen(function* () {
      calls.push({ args, terminal });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed++;
        }),
      );
      const login = args.includes("login");
      if (args.includes("logout")) yield* Deferred.succeed(logoutStarted, undefined);
      return {
        output: login
          ? Stream.fromQueue(output)
          : Stream.make(
              args.includes("logout")
                ? ""
                : provider === "claude"
                  ? options.verify === false
                    ? '{"loggedIn":false,"authMethod":"none"}'
                    : '{"loggedIn":true,"authMethod":"claude.ai"}'
                  : options.verify === false
                    ? "Not logged in"
                    : "You are logged in with grok.com.",
            ),
        exitCode: login
          ? Deferred.await(exited)
          : options.hangLogout && args.includes("logout")
            ? Effect.never
            : Effect.succeed(options.logoutFails && args.includes("logout") ? 1 : 0),
        write: (value: string) =>
          Effect.sync(() => {
            input.push(value);
          }),
      };
    });
  const controller = yield* makeCliProviderAuth({
    instanceId,
    provider,
    credentialKey: `${provider}:/fixture/account`,
    enabled: options.enabled ?? true,
    spawn,
    onChanged: Effect.sync(() => {
      refreshed++;
    }),
  });
  const phase = (expected: ProviderAuthState["phase"], owner = "owner") =>
    controller.subscribe(owner).pipe(
      Stream.filter((state) => state.phase === expected || state.phase === "failed"),
      Stream.runHead,
      Effect.map((value) => {
        const state = Option.getOrThrow(value);
        assert.equal(state.phase, expected, state.message ?? undefined);
        return state;
      }),
    );
  const emit = (text: string) => Queue.offer(output, text);
  const finish = (code = 0) =>
    Deferred.succeed(exited, code).pipe(Effect.andThen(Queue.end(output)));
  return {
    controller,
    phase,
    calls,
    input,
    emit,
    finish,
    logoutStarted,
    closed: () => closed,
    refreshed: () => refreshed,
  };
});

for (const provider of ["claude", "grok"] as const) {
  it.effect(`${provider}: relays only the owner's interaction and verifies the saved login`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider);
      assert.lengthOf(h.calls, 0);
      const started = yield* h.controller.start("owner");
      yield* h.emit(messages[provider].slice(0, 40));
      yield* h.emit(messages[provider].slice(40));
      const waiting = yield* h.phase("waiting");
      assert.equal(
        waiting.interaction?.type,
        provider === "claude" ? "authorizationCode" : "deviceCode",
      );
      assert.equal(waiting.authorizationUrl, provider === "claude" ? claudeUrl : grokUrl);
      const other = yield* h.phase("waiting", "other");
      assert.isNull(other.interaction);
      assert.isNull(other.authorizationUrl);
      assert.isNull(other.flowId);
      assert.deepEqual(h.calls[0], {
        args: provider === "claude" ? ["auth", "login", "--claudeai"] : ["login", "--device-auth"],
        terminal: provider === "claude",
      });
      if (provider === "claude") {
        const response = {
          instanceId,
          flowId: started.flowId!,
          interactionId: started.flowId!,
          response: { type: "authorizationCode" as const, code: "fixture-code#state" },
        };
        assert.isTrue(
          Exit.isFailure(yield* h.controller.respond!("other", response).pipe(Effect.exit)),
        );
        yield* h.controller.respond!("owner", response);
        assert.deepEqual(h.input, ["fixture-code#state\r"]);
        yield* h.phase("verifying");
        assert.isTrue(
          Exit.isFailure(yield* h.controller.respond!("owner", response).pipe(Effect.exit)),
        );
      }
      yield* h.finish();
      const done = yield* h.phase("succeeded");
      assert.isNull(done.interaction);
      assert.equal(h.refreshed(), 1);
      assert.equal(h.closed(), 2);
      assert.deepEqual(h.calls[1]?.args, provider === "claude" ? ["auth", "status"] : ["models"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(`${provider}: cancellation closes the login before returning`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider);
      const flow = yield* h.controller.start("owner");
      yield* h.emit(messages[provider]);
      yield* h.phase("waiting");
      const state = yield* h.controller.cancel("owner", flow.flowId!);
      assert.equal(state.phase, "cancelled");
      assert.isNull(state.interaction);
      assert.equal(h.closed(), 1);
      assert.equal(h.refreshed(), 0);
      assert.lengthOf(h.calls, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(`${provider}: expires an abandoned login and releases the process`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider);
      yield* h.controller.start("owner");
      yield* h.emit(messages[provider]);
      yield* h.phase("waiting");
      yield* TestClock.adjust(15 * 60_000 + 1);
      assert.include((yield* h.phase("failed")).message!, "expired");
      assert.equal(h.closed(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(`${provider}: does not trust an exit-zero login when account verification fails`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider, { verify: false });
      yield* h.controller.start("owner");
      yield* h.emit(messages[provider]);
      yield* h.phase("waiting");
      yield* h.finish();
      assert.include((yield* h.phase("failed")).message!, "did not confirm");
      assert.equal(h.refreshed(), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(`${provider}: keeps raw native errors and tokens out of client state`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider);
      yield* h.controller.start("owner");
      yield* h.emit("fatal: native-secret-token\n");
      yield* h.finish(1);
      const failed = yield* h.phase("failed");
      assert.notInclude(failed.message!, "native-secret-token");
      assert.isNull(failed.interaction);
      assert.equal(h.closed(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(`${provider}: logout is explicit and does not invoke login`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider);
      let stopped = false;
      yield* h.controller.logout(
        Effect.sync(() => {
          stopped = true;
        }),
      );
      assert.isTrue(stopped);
      assert.deepEqual(h.calls, [
        { args: provider === "claude" ? ["auth", "logout"] : ["logout"], terminal: false },
      ]);
      assert.equal(h.refreshed(), 1);
      assert.equal(h.closed(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(`${provider}: unsupported credential modes never launch login or logout`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider, { enabled: false });
      yield* h.controller.start("owner");
      yield* h.phase("failed");
      assert.isTrue(Exit.isFailure(yield* h.controller.logout(Effect.void).pipe(Effect.exit)));
      assert.lengthOf(h.calls, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(`${provider}: a stuck logout times out and releases the instance`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(provider, { hangLogout: true });
      const loggingOut = yield* h.controller
        .logout(Effect.void)
        .pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(h.logoutStarted);
      yield* TestClock.adjust(30_001);
      assert.isTrue(Exit.isFailure(yield* Fiber.join(loggingOut)));
      assert.equal(h.closed(), 1);
      assert.equal(h.refreshed(), 0);
      yield* h.controller.start("owner");
      yield* h.emit(messages[provider]);
      yield* h.phase("waiting");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("bounds unexpected CLI output and releases the login process", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("claude");
    yield* h.controller.start("owner");
    yield* h.emit("x".repeat(128 * 1024 + 1));
    assert.include((yield* h.phase("failed")).message!, "too much output");
    assert.equal(h.closed(), 1);
    assert.equal(h.refreshed(), 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("disposing the instance closes an outstanding login", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const h = yield* makeHarness("claude").pipe(Effect.provideService(Scope.Scope, scope));
    yield* h.controller.start("owner");
    yield* h.emit(messages.claude);
    yield* h.phase("waiting");
    yield* Scope.close(scope, Exit.void);
    assert.equal(h.closed(), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("rejects terminal control characters and permits retry after invalid input", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness("claude");
    const flow = yield* h.controller.start("owner");
    yield* h.emit(messages.claude);
    yield* h.phase("waiting");
    const respond = (code: string) =>
      h.controller.respond!("owner", {
        instanceId,
        flowId: flow.flowId!,
        interactionId: flow.flowId!,
        response: { type: "authorizationCode", code },
      });
    assert.isTrue(Exit.isFailure(yield* respond("code\ncommand").pipe(Effect.exit)));
    assert.lengthOf(h.input, 0);
    yield* respond("good-code#state");
    assert.deepEqual(h.input, ["good-code#state\r"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("parses official Grok prompts and waits for complete output chunks", () => {
  assert.deepEqual(readCliLoginInteraction("grok", messages.grok), {
    type: "deviceCode",
    url: grokUrl,
    userCode: "ABCD-EFGH",
  });
  assert.deepEqual(
    readCliLoginInteraction(
      "grok",
      `${grokUrl}\nConfirm this code in your browser:\n\nABCD-EFGH\n`,
    ),
    { type: "deviceCode", url: grokUrl, userCode: "ABCD-EFGH" },
  );
  assert.isNull(readCliLoginInteraction("claude", claudeUrl));
  assert.isNull(
    readCliLoginInteraction("claude", messages.claude.replace("claude.ai", "example.com")),
  );
  assert.isNull(readCliLoginInteraction("grok", messages.grok.replace("auth.x.ai", "example.com")));
  assert.isFalse(isCliAuthorizationCode("code\u001b[31m"));
});

it("does not replace external credentials with a browser login", () => {
  assert.isTrue(supportsClaudeBrowserLogin({}));
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    assert.isFalse(supportsClaudeBrowserLogin({ [key]: "1" }));
  assert.isTrue(supportsGrokBrowserLogin({}));
  assert.isFalse(supportsGrokBrowserLogin({ XAI_API_KEY: "fixture" }));
  for (const key of [
    "GROK_AUTH",
    "GROK_AUTH_PROVIDER_COMMAND",
    "GROK_LOCAL_AUTH",
    "GROK_OIDC_ISSUER",
    "GROK_OIDC_CLIENT_ID",
    "GROK_OAUTH2_ISSUER",
    "GROK_OAUTH2_CLIENT_ID",
  ]) {
    assert.isFalse(supportsGrokBrowserLogin({ [key]: "custom-login" }));
  }
});
