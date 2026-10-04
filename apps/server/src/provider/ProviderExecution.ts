// @effect-diagnostics nodeBuiltinImport:off - Claude's SDK requires a synchronous Node process factory with native streams.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Options as ClaudeOptions } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceExecution,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderDriverError } from "./Errors.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { spawnAndCollect } from "./providerSnapshot.ts";
import { registerProviderFileRoots } from "../mcp/McpProviderSession.ts";
import { registerProviderCredentialSocket } from "../mcp/McpProviderSession.ts";
import { CredentialShellBroker } from "../credentials/CredentialShellBroker.ts";
import * as Option from "effect/Option";

const SandboxDescription = Schema.Struct({
  instanceId: Schema.String,
  driver: Schema.String,
  uid: Schema.Number,
  gid: Schema.Number,
  home: Schema.String,
  providerHome: Schema.String,
  defaultCwd: Schema.String,
  path: Schema.String,
  visiblePaths: Schema.Array(Schema.String),
  mcpHost: Schema.optionalKey(Schema.String),
  credentialBrokerDirectory: Schema.optionalKey(Schema.String),
  softwareDirectory: Schema.optionalKey(Schema.String),
});
const decodeDescription = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxDescription));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const launcherEnvironment = { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C.UTF-8" };
const DEFAULT_LAUNCHER = "/usr/local/libexec/t3code-sandbox";
const inheritedDefaults = new Set([
  "LANG",
  "TZ",
  "TERM",
  "COLORTERM",
  "LC_ALL",
  "LC_CTYPE",
  "LC_COLLATE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "LC_PAPER",
  "LC_NAME",
  "LC_ADDRESS",
  "LC_TELEPHONE",
  "LC_MEASUREMENT",
  "LC_IDENTIFICATION",
]);

/** Only presentation defaults cross from the T3 process into an isolated instance. */
export function sandboxBaseEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(base).filter(
      ([key, value]) => value !== undefined && inheritedDefaults.has(key),
    ),
  );
}

export function sandboxProcessEnvironment(
  description: typeof SandboxDescription.Type,
  environment: ProviderInstanceEnvironment,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...mergeProviderInstanceEnvironment(environment, sandboxBaseEnvironment(base)),
    PATH: description.path,
    HOME: description.home,
    USER: `t3h-${description.uid}`,
    LOGNAME: `t3h-${description.uid}`,
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: NodePath.join(description.providerHome, "xdg"),
    ...(description.softwareDirectory
      ? {
          NPM_CONFIG_PREFIX: description.softwareDirectory,
          NPM_CONFIG_CACHE: NodePath.join(description.softwareDirectory, ".npm-cache"),
          NPM_CONFIG_USERCONFIG: NodePath.join(description.providerHome, "npmrc"),
        }
      : {}),
    ...(description.driver === "codex" ? { CODEX_HOME: description.providerHome } : {}),
    ...(description.driver === "claudeAgent"
      ? { CLAUDE_CONFIG_DIR: description.providerHome }
      : {}),
    ...(description.driver === "grok" ? { GROK_HOME: description.providerHome } : {}),
  };
}

interface LaunchRequest {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export const makeProviderExecution = Effect.fn("makeProviderExecution")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly execution: ProviderInstanceExecution | undefined;
  readonly environment: ProviderInstanceEnvironment;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  if (!input.execution) {
    return {
      spawner,
      environment: mergeProviderInstanceEnvironment(input.environment),
      description: undefined,
      spawnClaudeCodeProcess: undefined,
    };
  }
  const fail = (detail: string) =>
    new ProviderDriverError({ driver: input.driver, instanceId: input.instanceId, detail });
  if ((yield* HostProcessPlatform) !== "linux") {
    return yield* fail("Linux sandbox execution requires a Linux host.");
  }
  const launcher = process.env.T3CODE_SANDBOX_LAUNCHER || DEFAULT_LAUNCHER;
  const profile = input.execution.profile;
  const command = ChildProcess.make(
    "/usr/bin/sudo",
    ["-n", "--", launcher, "describe", profile, input.instanceId, input.driver],
    { env: launcherEnvironment },
  );
  const description = yield* Effect.scoped(
    spawnAndCollect(launcher, command).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? decodeDescription(result.stdout).pipe(
              Effect.mapError(() => fail("Invalid host sandbox profile description.")),
            )
          : Effect.fail(fail("The host sandbox profile is unavailable.")),
      ),
      Effect.mapError(() =>
        fail(`Cannot open sandbox profile '${profile}'. Check host provisioning.`),
      ),
    ),
  );
  if (description.instanceId !== input.instanceId || description.driver !== input.driver) {
    return yield* fail("The sandbox profile belongs to a different provider instance.");
  }
  const unregister = registerProviderFileRoots(input.instanceId, description.visiblePaths);
  yield* Effect.addFinalizer(() => Effect.sync(unregister));
  const environment = sandboxProcessEnvironment(description, input.environment);
  if (description.credentialBrokerDirectory) {
    const broker = yield* Effect.serviceOption(CredentialShellBroker);
    if (Option.isNone(broker)) return yield* fail("The credential shell broker is unavailable.");
    const socket = yield* broker.value
      .open(description.credentialBrokerDirectory)
      .pipe(Effect.mapError(() => fail("Cannot start the credential shell broker.")));
    environment.T3_CREDENTIAL_SOCKET = socket;
    environment.SHELL = "/bin/bash";
    const unregisterSocket = registerProviderCredentialSocket(
      input.instanceId,
      socket,
      description.mcpHost,
    );
    yield* Effect.addFinalizer(() => Effect.sync(unregisterSocket));
  }
  const makeRequest = (
    argv: ReadonlyArray<string>,
    cwd: string | undefined,
    env: NodeJS.ProcessEnv,
  ) =>
    ({
      instanceId: input.instanceId,
      driver: input.driver,
      argv,
      cwd: cwd ?? description.defaultCwd,
      env: { ...environment, ...env },
    }) satisfies LaunchRequest;

  const wrapCommand = Effect.fn("sandbox.wrapCommand")(function* (
    command: ChildProcess.Command,
  ): Effect.fn.Return<
    ChildProcess.Command,
    PlatformError.PlatformError,
    import("effect/Scope").Scope
  > {
    if (command._tag === "PipedCommand") {
      return ChildProcess.pipeTo(
        yield* wrapCommand(command.left),
        yield* wrapCommand(command.right),
        command.options,
      );
    }
    if (command.options.shell) {
      return yield* PlatformError.badArgument({
        module: "ProviderExecution",
        method: "spawn",
        description: "Sandbox launch expects parsed argv. Use an explicit shell executable.",
      });
    }
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-sandbox-" });
    const manifest = NodePath.join(directory, "request.json");
    // Keep native stdin for the provider protocol. Values never become launcher argv.
    yield* fileSystem.writeFileString(
      manifest,
      encodeJson(
        makeRequest(
          [command.command, ...command.args],
          command.options.cwd,
          command.options.env ?? {},
        ),
      ),
      { mode: 0o600 },
    );
    return ChildProcess.make("/usr/bin/sudo", ["-n", "--", launcher, "run", profile, manifest], {
      ...command.options,
      cwd: undefined,
      env: launcherEnvironment,
      extendEnv: false,
      shell: false,
      forceKillAfter: Duration.seconds(3),
    });
  });
  const sandboxSpawner = ChildProcessSpawner.make((command) =>
    wrapCommand(command).pipe(Effect.flatMap(spawner.spawn)),
  );

  const spawnClaudeCodeProcess: NonNullable<ClaudeOptions["spawnClaudeCodeProcess"]> = (
    options,
  ) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sandbox-"));
    const manifest = NodePath.join(directory, "request.json");
    const cleanup = () => NodeFS.rmSync(directory, { recursive: true, force: true });
    try {
      NodeFS.writeFileSync(
        manifest,
        encodeJson(makeRequest([options.command, ...options.args], options.cwd, options.env)),
        { mode: 0o600 },
      );
      const child = NodeChildProcess.spawn(
        "/usr/bin/sudo",
        ["-n", "--", launcher, "run", profile, manifest],
        { env: launcherEnvironment, stdio: ["pipe", "pipe", "pipe"], signal: options.signal },
      );
      child.once("close", cleanup);
      child.once("error", cleanup);
      // The privileged supervisor escalates itself and must survive to reap
      // the container. SDK hard-stop still ends the native process forcibly.
      const kill = child.kill.bind(child);
      child.kill = (signal) => kill(signal === "SIGKILL" ? "SIGTERM" : signal);
      return child;
    } catch (error) {
      cleanup();
      throw error;
    }
  };
  return { spawner: sandboxSpawner, environment, description, spawnClaudeCodeProcess };
});
