import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";

export interface ProviderLoginProcess {
  readonly output: Stream.Stream<string, ProviderSetupError>;
  readonly exitCode: Effect.Effect<number, ProviderSetupError>;
  readonly write: (value: string) => Effect.Effect<void, ProviderSetupError>;
}

export type SpawnProviderLogin = (
  args: ReadonlyArray<string>,
  terminal?: boolean,
) => Effect.Effect<ProviderLoginProcess, ProviderSetupError, Scope.Scope>;

/** A login is a scoped child process, never a shell command assembled from user input. */
export const makeProviderLoginSpawner = Effect.fn("makeProviderLoginSpawner")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configuredPty = yield* Effect.serviceOption(PtyAdapter.PtyAdapter);
  const fail = () =>
    new ProviderSetupError({
      instanceId: options.instanceId,
      operation: "process",
      detail:
        "Could not run the instance's login command. Check its CLI, execution environment, and network.",
    });
  const start: SpawnProviderLogin = (args, terminal = false) =>
    Effect.gen(function* () {
      if (terminal) {
        const adapter =
          configuredPty._tag === "Some"
            ? configuredPty.value
            : yield* NodePtyAdapter.make().pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
                Effect.catchCause(() => Effect.fail(fail())),
              );
        const output = yield* Queue.unbounded<string, Cause.Done>();
        const exited = yield* Deferred.make<number>();
        const { child } = yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const child = yield* adapter
              .spawn({
                shell: options.binaryPath,
                args: [...args],
                cwd: options.cwd,
                env: options.environment,
                cols: 4096,
                rows: 40,
              })
              .pipe(Effect.mapError(fail));
            const unsubscribeData = child.onData((data) => Queue.offerUnsafe(output, data));
            const unsubscribeExit = child.onExit((event) => {
              Deferred.doneUnsafe(
                exited,
                Effect.succeed(event.signal ? 128 + event.signal : event.exitCode),
              );
              Queue.endUnsafe(output);
            });
            return { child, unsubscribeData, unsubscribeExit };
          }),
          ({ child, unsubscribeData, unsubscribeExit }) =>
            Effect.gen(function* () {
              if (!(yield* Deferred.isDone(exited))) {
                yield* Effect.sync(() => {
                  try {
                    child.kill();
                  } catch {
                    /* Already exited. */
                  }
                });
                const stopped = yield* Deferred.await(exited).pipe(
                  Effect.interruptible,
                  Effect.timeoutOption("3 seconds"),
                );
                if (stopped._tag === "None") {
                  yield* Effect.sync(() => {
                    try {
                      child.kill("SIGKILL");
                    } catch {
                      /* Already exited. */
                    }
                  });
                  yield* Deferred.await(exited).pipe(
                    Effect.interruptible,
                    Effect.timeout("2 seconds"),
                    Effect.ignore,
                  );
                }
              }
              unsubscribeData();
              unsubscribeExit();
              Queue.endUnsafe(output);
            }),
        );
        return {
          output: Stream.fromQueue(output),
          exitCode: Deferred.await(exited),
          write: (value) => Effect.try({ try: () => child.write(value), catch: fail }),
        } satisfies ProviderLoginProcess;
      }
      const resolved = yield* resolveSpawnCommand(options.binaryPath, [...args], {
        env: options.environment,
        extendEnv: true,
      });
      const child = yield* spawner
        .spawn(
          ChildProcess.make(resolved.command, resolved.args, {
            cwd: options.cwd,
            env: options.environment,
            extendEnv: true,
            shell: resolved.shell,
            forceKillAfter: "3 seconds",
          }),
        )
        .pipe(Effect.mapError(fail));
      const input = yield* Queue.unbounded<string>();
      yield* Stream.fromQueue(input).pipe(
        Stream.encodeText,
        Stream.run(child.stdin),
        Effect.forkScoped,
      );
      return {
        output: Stream.merge(
          child.stdout.pipe(Stream.decodeText()),
          child.stderr.pipe(Stream.decodeText()),
        ).pipe(Stream.mapError(fail)),
        exitCode: child.exitCode.pipe(Effect.map(Number), Effect.mapError(fail)),
        write: (value) => Queue.offer(input, value).pipe(Effect.asVoid),
      } satisfies ProviderLoginProcess;
    });
  return start;
});
