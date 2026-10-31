import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import {
  ProviderGatewayError,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  gatewayHeaders,
  gatewayModels,
  gatewayProblem,
  GATEWAY_KEY,
} from "@t3tools/shared/providerGateway";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ProviderInstance } from "./ProviderDriver.ts";

const quoteArgument = (value: string) => JSON.stringify(value);

/** Apply native per-process overrides; never rewrite the user's CLI files or credentials. */
export function projectGatewayInstance(
  entry: ProviderInstanceConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): ProviderInstanceConfig {
  const gateway = entry.gateway;
  if (!gateway?.enabled) return entry;
  const problem = gatewayProblem(entry.driver, gateway);
  if (problem) throw new ProviderGatewayError({ detail: problem });
  const config = entry.config && typeof entry.config === "object" ? entry.config : {};
  if (entry.driver === "codex" && "setupMode" in config && config.setupMode === "managed")
    throw new ProviderGatewayError({
      detail: "Select the local Codex runtime before enabling a custom gateway.",
    });
  if (
    entry.driver === "claudeAgent" &&
    "launchArgs" in config &&
    typeof config.launchArgs === "string" &&
    tokenizeCliArgs(config.launchArgs).some(
      (arg) => arg === "--settings" || arg.startsWith("--settings="),
    )
  )
    throw new ProviderGatewayError({
      detail:
        "Custom --settings launch arguments conflict with the gateway. Move those values into native settings files first.",
    });
  const headers = gatewayHeaders(gateway, entry.environment ?? []);
  const environment = new Map((entry.environment ?? []).map((row) => [row.name, row]));
  const set = (name: string, value: string, sensitive = false) =>
    environment.set(name, { name, value, sensitive });
  const baseUrl = gateway.baseUrl.trim().replace(/\/+$/, "");
  if (entry.driver === "claudeAgent") {
    set("T3_GATEWAY_ACTIVE", "claude");
    set("ANTHROPIC_BASE_URL", baseUrl);
    set(
      "ANTHROPIC_AUTH_TOKEN",
      gateway.auth === "bearer" ? headers.Authorization!.slice(7) : "",
      true,
    );
    set("ANTHROPIC_API_KEY", gateway.auth === "api-key" ? headers["x-api-key"]! : "", true);
    // Explicit API credentials take precedence over saved OAuth; the saved login is untouched.
    for (const name of [
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    ])
      set(name, "", true);
    for (const name of [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ])
      set(name, "0");
    set("ANTHROPIC_MODEL", gateway.model);
    for (const role of ["opus", "sonnet", "haiku"] as const)
      set(`ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`, gateway.roles[role] ?? gateway.model);
    set("ANTHROPIC_DEFAULT_FABLE_MODEL", gateway.model);
    set("CLAUDE_CODE_SUBAGENT_MODEL", gateway.roles.subagent ?? gateway.model);
    set("ANTHROPIC_SMALL_FAST_MODEL", gateway.roles.haiku ?? gateway.model);
    set(
      "ANTHROPIC_CUSTOM_HEADERS",
      gateway.headers.map((header) => `${header.name}: ${headers[header.name]}`).join("\n"),
      true,
    );
  } else {
    set("T3_GATEWAY_ACTIVE", "codex");
    const provider = "model_providers.t3_gateway";
    const overrides: Array<[string, string | boolean]> = [
      ["model_provider", "t3_gateway"],
      ["model", gateway.model],
      [`${provider}.name`, "T3 custom gateway"],
      [`${provider}.base_url`, baseUrl],
      [`${provider}.wire_api`, "responses"],
      [`${provider}.requires_openai_auth`, false],
      [`${provider}.supports_websockets`, false],
    ];
    if (gateway.auth === "bearer") overrides.push([`${provider}.env_key`, GATEWAY_KEY]);
    else overrides.push([`${provider}.env_http_headers."x-api-key"`, GATEWAY_KEY]);
    for (const header of gateway.headers)
      overrides.push([
        `${provider}.env_http_headers.${JSON.stringify(header.name)}`,
        header.variable,
      ]);
    const previous =
      environment.get("T3CODE_CODEX_LAUNCH_ARGS")?.value ||
      baseEnv.T3CODE_CODEX_LAUNCH_ARGS ||
      ("launchArgs" in config && typeof config.launchArgs === "string" ? config.launchArgs : "");
    const args = overrides
      .map(([key, value]) => `-c ${quoteArgument(`${key}=${JSON.stringify(value)}`)}`)
      .join(" ");
    set("T3CODE_CODEX_LAUNCH_ARGS", `${previous} ${args}`.trim());
  }
  return {
    ...entry,
    environment: [...environment.values()],
    config: { ...config, customModels: gatewayModels(gateway) },
  };
}

export function gatewaySnapshot(
  entry: ProviderInstanceConfig,
  snapshot: ServerProvider,
): ServerProvider {
  if (!entry.gateway?.enabled) return snapshot;
  const { usageLimits: _limits, ...rest } = snapshot;
  return {
    ...rest,
    auth: { status: "unknown", type: "apiKey", label: "Custom API gateway" },
    setup: { canAuthenticate: false, canInstall: snapshot.setup?.canInstall ?? false },
    // CLI account probes describe the saved subscription, not this separately configured gateway.
    status:
      snapshot.status === "error"
        ? "error"
        : snapshot.installed && snapshot.enabled
          ? "ready"
          : snapshot.status,
    message:
      snapshot.status === "error" && snapshot.message
        ? snapshot.message
        : "Custom API gateway configured. Use Test connection to verify inference.",
    models: gatewayModels(entry.gateway).map((model) => ({
      slug: model,
      name: model,
      isCustom: true,
      isDefault: model === entry.gateway!.model,
      capabilities: null,
    })),
  };
}

export function withGatewayInstance(
  entry: ProviderInstanceConfig,
  instance: ProviderInstance,
): ProviderInstance {
  if (!entry.gateway?.enabled) return instance;
  const { auth: _auth, consumeResetCredit: _reset, ...rest } = instance;
  const stamp = (value: ServerProvider) => gatewaySnapshot(entry, value);
  return {
    ...rest,
    snapshot: {
      ...instance.snapshot,
      getSnapshot: instance.snapshot.getSnapshot.pipe(Effect.map(stamp)),
      refresh: instance.snapshot.refresh.pipe(Effect.map(stamp)),
      streamChanges: instance.snapshot.streamChanges.pipe(Stream.map(stamp)),
    },
    ...(instance.snapshotForCwd
      ? { snapshotForCwd: (cwd: string) => instance.snapshotForCwd!(cwd).pipe(Effect.map(stamp)) }
      : {}),
  };
}
