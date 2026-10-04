import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeCodexAuth } from "./CodexAuth.ts";
import { withCodexAppServerClient } from "./Layers/CodexProvider.ts";

const instanceId = ProviderInstanceId.make("codex-device-test");
const loginId = "fixture-login";
const secret = "native-token-must-not-escape";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Number),
      method: Schema.String,
      params: Schema.optionalKey(Schema.Unknown),
    }),
  ),
);

const makeHarness = Effect.fnUntraced(function* (
  options: {
    earlyCompletion?: boolean;
    failStart?: boolean;
    invalidUrl?: boolean;
    missingAccount?: boolean;
    enabled?: boolean;
    hangCancel?: boolean;
    hangLogout?: boolean;
  } = {},
) {
  const requests: Array<{ method: string; params?: unknown }> = [];
  const launches: Array<ChildProcess.StandardCommand> = [];
  const output = yield* Queue.unbounded<string>();
  const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  const cancellationRequested = yield* Deferred.make<void>();
  const logoutRequested = yield* Deferred.make<void>();
  const emit = (message: unknown) =>
    Queue.offer(output, `${encode(message)}\n`).pipe(Effect.asVoid);
  const complete = (success = true, id = loginId) =>
    emit({
      method: "account/login/completed",
      params: { loginId: id, success, error: success ? null : secret },
    });
  let closed = 0;
  let refreshed = 0;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) return yield* Effect.die("Expected command");
      launches.push(command);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed++;
        }),
      );
      let buffered = "";
      const decoder = new TextDecoder();
      const stdin = Sink.forEach((chunk: Uint8Array) =>
        Effect.gen(function* () {
          buffered += decoder.decode(chunk, { stream: true });
          while (buffered.includes("\n")) {
            const end = buffered.indexOf("\n");
            const request = decodeRequest(buffered.slice(0, end));
            buffered = buffered.slice(end + 1);
            requests.push(request);
            if (request.id === undefined) continue;
            const reply = (result: unknown) => emit({ id: request.id, result });
            switch (request.method) {
              case "initialize":
                yield* reply({
                  userAgent: "fixture-codex",
                  codexHome: "/fixture/private-codex-home",
                  platformFamily: "unix",
                  platformOs: "linux",
                });
                break;
              case "account/login/start":
                if (options.failStart) {
                  yield* emit({ id: request.id, error: { code: -32602, message: secret } });
                  break;
                }
                if (options.earlyCompletion) yield* complete();
                yield* reply({
                  type: "chatgptDeviceCode",
                  loginId,
                  userCode: "ABCD-1234",
                  verificationUrl: options.invalidUrl
                    ? "https://example.com/login"
                    : "https://auth.openai.com/codex/device",
                });
                break;
              case "account/login/cancel":
                yield* Deferred.succeed(cancellationRequested, undefined);
                if (options.hangCancel) break;
                yield* reply({ status: "canceled" });
                break;
              case "account/read":
                yield* reply({
                  account: options.missingAccount
                    ? null
                    : { type: "chatgpt", email: "fixture@example.com", planType: "plus" },
                  requiresOpenaiAuth: true,
                });
                break;
              case "account/logout":
                yield* Deferred.succeed(logoutRequested, undefined);
                if (options.hangLogout) break;
                yield* reply({});
                break;
              default:
                return yield* Effect.die(`Unexpected request: ${request.method}`);
            }
          }
        }),
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(123),
        exitCode: Deferred.await(exited),
        isRunning: Effect.succeed(true),
        kill: () => Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0)).pipe(Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin,
        stdout: Stream.fromQueue(output).pipe(Stream.encodeText),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const controller = yield* makeCodexAuth({
    instanceId,
    credentialKey: "codex:/fixture/private-codex-home",
    enabled: options.enabled ?? true,
    connect: withCodexAppServerClient({
      binaryPath: "/fixture/codex",
      homePath: "/fixture/private-codex-home",
      cwd: "/fixture/workspace",
      environment: { HOME: "/fixture/home", INSTANCE_MARKER: "codex-device-test" },
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    onChanged: Effect.sync(() => {
      refreshed++;
    }),
  });
  const phase = (phase: ProviderAuthState["phase"], owner = "owner") =>
    controller.subscribe(owner).pipe(
      Stream.filter((state) => state.phase === phase || state.phase === "failed"),
      Stream.runHead,
      Effect.map((result) => {
        const state = Option.getOrThrow(result);
        assert.equal(state.phase, phase, state.message ?? undefined);
        return state;
      }),
    );
  return {
    controller,
    phase,
    complete,
    requests,
    launches,
    exited,
    cancellationRequested,
    logoutRequested,
    closed: () => closed,
    refreshed: () => refreshed,
  };
});

it.effect("uses the selected home and spawner; only the owning client sees the code", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    assert.lengthOf(h.launches, 0);
    const started = yield* h.controller.start("owner");
    const waiting = yield* h.phase("waiting");
    assert.deepEqual(waiting.interaction, {
      type: "deviceCode",
      id: started.flowId!,
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
    assert.equal(h.refreshed(), 0);
    assert.deepInclude(h.launches[0]!.options.env, {
      CODEX_HOME: "/fixture/private-codex-home",
      HOME: "/fixture/home",
      INSTANCE_MARKER: "codex-device-test",
    });
    assert.equal(h.launches[0]!.options.cwd, "/fixture/workspace");
    assert.deepInclude(
      h.requests.find((request) => request.method === "account/login/start"),
      { params: { type: "chatgptDeviceCode" } },
    );
    const other = yield* h.phase("waiting", "other");
    assert.isNull(other.interaction);
    assert.isNull(other.authorizationUrl);
    assert.isNull(other.flowId);
    assert.isTrue(
      Exit.isFailure(yield* h.controller.cancel("other", started.flowId!).pipe(Effect.exit)),
    );
    yield* h.controller.start("owner");
    assert.lengthOf(h.launches, 1);
    yield* h.complete(true, "unrelated-login");
    yield* h.complete();
    const done = yield* h.phase("succeeded");
    assert.isNull(done.interaction);
    assert.equal(h.refreshed(), 1);
    assert.equal(h.closed(), 1);
    assert.isFalse(h.requests.some((request) => request.method === "account/login/cancel"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not lose a completion arriving before the start response", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ earlyCompletion: true });
    yield* h.controller.start("owner");
    yield* h.phase("succeeded");
    assert.equal(h.refreshed(), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancels the official login and closes its process before returning", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const start = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    const cancelled = yield* h.controller.cancel("owner", start.flowId!);
    assert.equal(cancelled.phase, "cancelled");
    assert.isNull(cancelled.interaction);
    assert.deepInclude(
      h.requests.find((request) => request.method === "account/login/cancel"),
      { params: { loginId } },
    );
    assert.equal(h.closed(), 1);
    assert.equal(h.refreshed(), 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("expires and cleans up a pending device login", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* TestClock.adjust(15 * 60_000 + 1);
    const failed = yield* h.phase("failed");
    assert.include(failed.message!, "expired");
    assert.isNull(failed.interaction);
    assert.equal(h.closed(), 1);
    assert.isTrue(h.requests.some((request) => request.method === "account/login/cancel"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("bounds cleanup when Codex never acknowledges cancellation", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ hangCancel: true });
    const start = yield* h.controller.start("owner");
    yield* h.phase("waiting");
    const cancelling = yield* h.controller.cancel("owner", start.flowId!).pipe(Effect.forkScoped);
    yield* Deferred.await(h.cancellationRequested);
    yield* TestClock.adjust(3_001);
    const cancelled = yield* Fiber.join(cancelling);
    assert.equal(cancelled.phase, "cancelled");
    assert.equal(h.closed(), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const options of [
  { failStart: true },
  { invalidUrl: true },
  { earlyCompletion: true, missingAccount: true },
]) {
  it.effect(`reports failure without native secrets: ${Object.keys(options).join(",")}`, () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(options);
      yield* h.controller.start("owner");
      const failed = yield* h.phase("failed");
      assert.notInclude(encode(failed), secret);
      assert.isNull(failed.interaction);
      assert.equal(h.refreshed(), 0);
      assert.equal(h.closed(), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect("hides native login failure details", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* h.complete(false);
    const failed = yield* h.phase("failed");
    assert.notInclude(encode(failed), secret);
    assert.equal(h.refreshed(), 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails promptly when the login process exits", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* Deferred.succeed(h.exited, ChildProcessSpawner.ExitCode(1));
    assert.include((yield* h.phase("failed")).message!, "exited");
    assert.equal(h.closed(), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("closes pending login when its instance is disposed", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const h = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
    yield* h.controller.start("owner");
    yield* h.phase("waiting");
    yield* Scope.close(scope, Exit.void);
    assert.equal(h.closed(), 1);
    assert.isTrue(h.requests.some((request) => request.method === "account/login/cancel"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("uses native logout only after explicit sign-out", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    assert.lengthOf(h.requests, 0);
    let stopped = false;
    const state = yield* h.controller.logout(
      Effect.sync(() => {
        stopped = true;
      }),
    );
    assert.isTrue(stopped);
    assert.equal(state.phase, "idle");
    assert.isTrue(h.requests.some((request) => request.method === "account/logout"));
    assert.isFalse(h.requests.some((request) => request.method === "account/login/start"));
    assert.equal(h.refreshed(), 1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cleans up and releases access when Codex does not respond to logout", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ hangLogout: true });
    const logout = yield* h.controller.logout(Effect.void).pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(h.logoutRequested);
    yield* TestClock.adjust(20_001);
    assert.isTrue(Exit.isFailure(yield* Fiber.join(logout)));
    assert.equal((yield* h.phase("failed")).message, "Could not sign out. Try again.");
    assert.equal(h.closed(), 1);
    assert.equal(h.refreshed(), 0);
    assert.isFalse(yield* h.controller.isChangingCredentials!);
    yield* h.controller.withAccess!(Effect.void);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("does not launch login for a disabled instance", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ enabled: false });
    yield* h.controller.start("owner");
    yield* h.phase("failed");
    assert.lengthOf(h.launches, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
