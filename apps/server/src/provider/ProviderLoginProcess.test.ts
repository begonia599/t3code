import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeProviderLoginSpawner } from "./ProviderLoginProcess.ts";
import { PtyAdapter, type PtyExitEvent } from "../terminal/PtyAdapter.ts";

const options = {
  instanceId: ProviderInstanceId.make("claude-login-process"),
  binaryPath: "/fixture/claude",
  cwd: "/fixture/workspace",
  environment: {
    HOME: "/fixture/home",
    CLAUDE_CONFIG_DIR: "/fixture/private-claude",
    HTTPS_PROXY: "http://fixture-proxy",
  },
};

it.effect("uses the instance environment for piped commands and keeps input off argv", () =>
  Effect.gen(function* () {
    let command: ChildProcess.StandardCommand | undefined;
    const written = yield* Deferred.make<string>();
    let closed = false;
    const spawner = ChildProcessSpawner.make((input) =>
      Effect.gen(function* () {
        assert.isTrue(ChildProcess.isStandardCommand(input));
        if (!ChildProcess.isStandardCommand(input))
          return yield* Effect.die("Expected standard command");
        command = input;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closed = true;
          }),
        );
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(123),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach((bytes: Uint8Array) =>
            Deferred.succeed(written, new TextDecoder().decode(bytes)),
          ),
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    );
    const scope = yield* Scope.make();
    const spawn = yield* makeProviderLoginSpawner(options).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const child = yield* spawn(["auth", "login"], false).pipe(
      Effect.provideService(Scope.Scope, scope),
    );
    assert.equal(command!.command, options.binaryPath);
    assert.deepEqual(command!.args, ["auth", "login"]);
    assert.deepEqual(command!.options.env, options.environment);
    assert.equal(command!.options.cwd, options.cwd);
    assert.isFalse(command!.options.shell ?? false);
    yield* child.write("fixture-code#state\r");
    assert.equal(yield* Deferred.await(written), "fixture-code#state\r");
    assert.isFalse(command!.args.some((arg) => arg.includes("fixture-code#state")));
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(closed);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("host terminal cleanup escalates a stuck child and waits for exit", () =>
  Effect.gen(function* () {
    let exit: ((event: PtyExitEvent) => void) | undefined;
    const signals: Array<string | undefined> = [];
    const killed = yield* Deferred.make<void>();
    let unsubscribed = 0;
    const adapter = PtyAdapter.of({
      spawn: () =>
        Effect.succeed({
          pid: 123,
          write: () => {},
          resize: () => {},
          kill: (signal) => {
            signals.push(signal);
            Deferred.doneUnsafe(killed, Effect.void);
            if (signal === "SIGKILL") exit?.({ exitCode: 1, signal: 9 });
          },
          onData: () => () => {
            unsubscribed++;
          },
          onExit: (callback) => {
            exit = callback;
            return () => {
              unsubscribed++;
            };
          },
        }),
    });
    const spawn = yield* makeProviderLoginSpawner(options).pipe(
      Effect.provideService(PtyAdapter, adapter),
    );
    const scope = yield* Scope.make();
    yield* spawn(["auth", "login"], true).pipe(Effect.provideService(Scope.Scope, scope));
    const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkScoped);
    yield* Deferred.await(killed);
    yield* TestClock.adjust(3_001);
    yield* Fiber.join(closing);
    assert.deepEqual(signals, [undefined, "SIGKILL"]);
    assert.equal(unsubscribed, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cancelling during native spawn still reaps the created terminal", () =>
  Effect.gen(function* () {
    const acquired = yield* Deferred.make<void>();
    const releaseSpawn = yield* Deferred.make<void>();
    let exited: ((event: PtyExitEvent) => void) | undefined;
    let killed = false;
    const adapter = PtyAdapter.of({
      spawn: () =>
        Effect.gen(function* () {
          yield* Deferred.succeed(acquired, undefined);
          yield* Deferred.await(releaseSpawn);
          return {
            pid: 123,
            write: () => {},
            resize: () => {},
            kill: () => {
              killed = true;
              exited?.({ exitCode: 0, signal: null });
            },
            onData: () => () => {},
            onExit: (callback) => {
              exited = callback;
              return () => {};
            },
          };
        }),
    });
    const spawn = yield* makeProviderLoginSpawner(options).pipe(
      Effect.provideService(PtyAdapter, adapter),
    );
    const running = yield* spawn(["auth", "login"], true).pipe(
      Effect.andThen(Effect.never),
      Effect.scoped,
      Effect.forkScoped,
    );
    yield* Deferred.await(acquired);
    yield* Effect.sync(() => running.interruptUnsafe());
    yield* Deferred.succeed(releaseSpawn, undefined);
    yield* Fiber.interrupt(running);
    assert.isTrue(killed);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.skipIf(HostProcessPlatform.defaultValue() !== "linux")(
  "the native terminal supports a real prompt using an isolated fixture",
  () =>
    Effect.gen(function* () {
      const spawn = yield* makeProviderLoginSpawner({
        ...options,
        binaryPath: "/usr/bin/python3",
        cwd: process.cwd(),
        environment: { PATH: "/usr/bin:/bin" },
      });
      const child = yield* spawn(
        [
          "-u",
          "-c",
          "import os,sys,termios; a=termios.tcgetattr(0); a[3] &= ~termios.ECHO; termios.tcsetattr(0,termios.TCSANOW,a); print('ready:'+str(os.isatty(0))); code=input(); print('accepted:'+str(code == 'fixture-code#state'))",
        ],
        true,
      );
      const ready = yield* Deferred.make<void>();
      let output = "";
      const reading = yield* child.output.pipe(
        Stream.runForEach((text) =>
          Effect.gen(function* () {
            output += text;
            if (output.includes("ready:True")) yield* Deferred.succeed(ready, undefined);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(ready);
      yield* child.write("fixture-code#state\r");
      assert.equal(yield* child.exitCode, 0);
      yield* Fiber.join(reading);
      assert.include(output, "accepted:True");
      assert.notInclude(output, "fixture-code#state");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
