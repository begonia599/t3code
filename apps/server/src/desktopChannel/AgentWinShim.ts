// @effect-diagnostics preferSchemaOverJson:off - Serialize standalone launcher source and constants.
import {
  DesktopExecErrorCode,
  WinGatewayErrorCode,
  DESKTOP_EXEC_MAX_TIMEOUT_MS,
  DESKTOP_EXEC_DEFAULT_TIMEOUT_MS,
  DESKTOP_EXEC_LOG_RETAINED,
  winExitCodeForError,
  WIN_EXIT_TIMEOUT,
  WIN_EXIT_CANCELLED,
  WIN_EXIT_STATE_UNKNOWN,
  WIN_GATEWAY_PATH_PREFIX,
} from "@t3tools/contracts";
import { resolveNodeExecutable } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { runWinLauncher } from "./winLauncher.ts";

export const launcherConstants = {
  defaultTimeoutMs: DESKTOP_EXEC_DEFAULT_TIMEOUT_MS,
  maxTimeoutMs: DESKTOP_EXEC_MAX_TIMEOUT_MS,
  maxLog: DESKTOP_EXEC_LOG_RETAINED,
  errorCodes: Object.fromEntries(
    [...DesktopExecErrorCode.literals, ...WinGatewayErrorCode.literals].map((code) => [
      code,
      winExitCodeForError(code),
    ]),
  ),
  resultCodes: {
    timedOut: WIN_EXIT_TIMEOUT,
    cancelled: WIN_EXIT_CANCELLED,
    unknown: WIN_EXIT_STATE_UNKNOWN,
  },
};

class AgentWinRuntimeError extends Schema.TaggedError<AgentWinRuntimeError>()(
  "AgentWinRuntimeError",
  { cause: Schema.Defect() },
) {
  override get message() {
    return "Windows command launcher requires Node.js on PATH.";
  }
}

export const ensureAgentWinShim = Effect.fn("AgentWinShim.ensure")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The shared resolver feature enum predates win; translate its error locally.
  const node = yield* resolveNodeExecutable("Device automation").pipe(
    Effect.mapError((cause) => new AgentWinRuntimeError({ cause })),
  );
  const bin = path.join(stateDir, "agent-win", "bin");
  yield* fs.makeDirectory(bin, { recursive: true });
  const temporary = yield* fs.makeTempDirectoryScoped({ directory: bin, prefix: ".win-" });
  const launcher = path.join(bin, "win-launcher.mjs");
  const temporaryLauncher = path.join(temporary, "win-launcher.mjs");
  yield* fs.writeFileString(
    temporaryLauncher,
    `import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
const write = stream => async text => { if (!stream.write(text)) await once(stream, 'drain'); };
const run = ${runWinLauncher.toString()};
process.exitCode = await run({ args: process.argv.slice(2), env: process.env, cwd: () => process.cwd(),
readFile: path => readFile(path, 'utf8'), stdin: async () => { let text = ''; for await (const chunk of process.stdin) text += chunk; return text; },
fetch, stdout: write(process.stdout), stderr: write(process.stderr),
onSignal: (name, listener) => { process.on(name, listener); return () => process.off(name, listener); },
constants: ${JSON.stringify(launcherConstants)} });\n`,
  );
  const command = [node, launcher].map((s) => "'" + s.replaceAll("'", "'\"'\"'") + "'").join(" ");
  const shim = path.join(bin, "win");
  const temporaryShim = path.join(temporary, "win");
  yield* fs.writeFileString(temporaryShim, `#!/bin/sh\nexec ${command} "$@"\n`);
  yield* fs.chmod(temporaryShim, 0o755);
  yield* fs.rename(temporaryLauncher, launcher);
  yield* fs.rename(temporaryShim, shim);
  return bin;
}, Effect.scoped);

/** Credentials are named by the registry's random session ID, never by the bearer itself. */
export const prepareAgentWinEnvironment = Effect.fn("AgentWinShim.environment")(function* (input: {
  stateDir: string;
  sessionId: string;
  endpoint: string;
  authorizationHeader: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bin = yield* ensureAgentWinShim(input.stateDir);
  const directory = path.join(input.stateDir, "agent-win", "credentials");
  yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  yield* fs.chmod(directory, 0o700);
  const file = path.join(directory, `${input.sessionId}.token`);
  yield* fs.writeFileString(file, input.authorizationHeader.replace(/^Bearer\s+/, ""), {
    mode: 0o600,
  });
  yield* fs.chmod(file, 0o600);
  return {
    PATH: bin,
    T3_WIN_ENDPOINT: new URL(WIN_GATEWAY_PATH_PREFIX, input.endpoint).href,
    T3_WIN_CREDENTIAL_FILE: file,
  };
});
