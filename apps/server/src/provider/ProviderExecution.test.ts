import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { makeProviderExecution, sandboxProcessEnvironment } from "./ProviderExecution.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const Request = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  env: Schema.Record(Schema.String, Schema.String),
});
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(Request));
const profile = {
  instanceId: "codex-personal",
  driver: "codex",
  uid: 1201,
  gid: 1201,
  home: "/srv/t3/home",
  providerHome: "/srv/t3/instances/codex-personal",
  defaultCwd: "/srv/t3/home",
  path: "/usr/bin:/bin",
  softwareDirectory: "/srv/t3/software/codex-personal",
  visiblePaths: ["/srv/t3/home", "/srv/t3/instances/codex-personal", "/srv/t3/project"],
};
const handle = (output: string, code = 0) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.encodeText(Stream.make(output)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

describe("provider execution", () => {
  it.each([
    ["claudeAgent", "CLAUDE_CONFIG_DIR"],
    ["codex", "CODEX_HOME"],
    ["grok", "GROK_HOME"],
  ])("isolates %s from server credentials and other accounts", (driver, homeKey) => {
    const environment = sandboxProcessEnvironment(
      { ...profile, driver },
      [
        { name: "PROJECT_OPTION", value: "readable", sensitive: false },
        { name: "HOME", value: "/wrong/account", sensitive: false },
        { name: "NPM_CONFIG_PREFIX", value: "/wrong/installation", sensitive: false },
      ],
      {
        LANG: "zh_CN.UTF-8",
        T3CODE_GITHUB_CLIENT_SECRET: "host-only",
        OTHER_ACCOUNT_TOKEN: "host-only",
        HOME: "/host/home",
        PATH: "/host/bin",
      },
    );
    expect(environment).toMatchObject({
      HOME: profile.home,
      PATH: profile.path,
      LANG: "zh_CN.UTF-8",
      PROJECT_OPTION: "readable",
      [homeKey!]: profile.providerHome,
      NPM_CONFIG_PREFIX: profile.softwareDirectory,
      NPM_CONFIG_CACHE: `${profile.softwareDirectory}/.npm-cache`,
    });
    expect(environment.T3CODE_GITHUB_CLIENT_SECRET).toBeUndefined();
    expect(environment.OTHER_ACCOUNT_TOKEN).toBeUndefined();
  });

  it.effect("passes native argv in a private manifest without consuming protocol stdin", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const calls: ChildProcess.StandardCommand[] = [];
      let request: typeof Request.Type | undefined;
      const observed = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command))
            return yield* Effect.die("Expected parsed command");
          calls.push(command);
          if (command.args[3] === "describe") return handle(encode(profile));
          request = decodeRequest(yield* fs.readFileString(command.args[5]!));
          expect((yield* fs.stat(command.args[5]!)).mode & 0o777).toBe(0o600);
          return handle("native-protocol-reply");
        }),
      );
      const runtime = yield* makeProviderExecution({
        instanceId: ProviderInstanceId.make(profile.instanceId),
        driver: ProviderDriverKind.make("codex"),
        execution: { mode: "linux-sandbox", profile: "personal" },
        environment: [{ name: "EXPLICIT_VENDOR_TOKEN", value: "fixture-value", sensitive: true }],
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed));
      const stdin = Stream.encodeText(Stream.make("native-request\n"));
      const child = yield* runtime.spawner.spawn(
        ChildProcess.make("codex", ["app-server", "argument with spaces"], {
          cwd: "/srv/t3/project",
          env: runtime.environment,
          stdin,
        }),
      );
      expect(
        yield* Stream.runFold(
          Stream.decodeText(child.stdout),
          () => "",
          (a, b) => a + b,
        ),
      ).toBe("native-protocol-reply");
      expect(request).toMatchObject({
        argv: ["codex", "app-server", "argument with spaces"],
        cwd: "/srv/t3/project",
        env: { EXPLICIT_VENDOR_TOKEN: "fixture-value", CODEX_HOME: profile.providerHome },
      });
      expect(calls[1]?.options.stdin).toBe(stdin);
      expect(calls[1]?.options.extendEnv).toBe(false);
      expect(calls[1]?.args.join(" ")).not.toContain("fixture-value");
      expect(calls[1]?.options.env).not.toHaveProperty("EXPLICIT_VENDOR_TOKEN");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails instead of falling back to the host when provisioning or binding is wrong", () =>
    Effect.gen(function* () {
      for (const [description, code] of [
        [profile, 125],
        [{ ...profile, instanceId: "other-account" }, 0],
      ] as const) {
        let calls = 0;
        const spawner = ChildProcessSpawner.make(() => {
          calls++;
          return Effect.succeed(handle(encode(description), code));
        });
        const result = yield* makeProviderExecution({
          instanceId: ProviderInstanceId.make(profile.instanceId),
          driver: ProviderDriverKind.make("codex"),
          execution: { mode: "linux-sandbox", profile: "personal" },
          environment: [],
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.result,
        );
        expect(result._tag).toBe("Failure");
        expect(calls).toBe(1);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
