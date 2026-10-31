import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const CLAUDE_GATEWAY_ENV_NAMES = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

/** --settings outranks user/project env blocks. Keep credentials out of process arguments. */
export const makeClaudeGatewaySettingsWriter = Effect.fn("makeClaudeGatewaySettingsWriter")(
  function* (environment: NodeJS.ProcessEnv) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory =
      environment.T3_GATEWAY_ACTIVE === "claude"
        ? yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-gateway-" }).pipe(Effect.orDie)
        : undefined;
    let sequence = 0;
    return <T extends { env?: Record<string, string> }>(settings: T) =>
      Effect.gen(function* () {
        if (!directory) return settings;
        const env = { ...settings.env };
        for (const name of CLAUDE_GATEWAY_ENV_NAMES) env[name] = environment[name] ?? "";
        const file = path.join(directory, `${sequence++}.json`);
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        yield* fs.writeFileString(file, JSON.stringify({ ...settings, env }), { mode: 0o600 });
        return file;
      });
  },
);
