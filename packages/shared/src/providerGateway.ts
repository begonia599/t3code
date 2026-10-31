import type {
  ProviderGatewayConfig,
  ProviderInstanceConfig,
  ProviderInstanceEnvironment,
} from "@t3tools/contracts";

export const GATEWAY_KEY = "T3_GATEWAY_API_KEY";
export const isGatewayVariable = (name: string) =>
  name === GATEWAY_KEY || /^T3_GATEWAY_HEADER_[0-9]+$/.test(name);
export const gatewayModels = (gateway: ProviderGatewayConfig): string[] => [
  ...new Set(
    [gateway.model, ...gateway.models, ...Object.values(gateway.roles)].filter(
      (model): model is string => Boolean(model),
    ),
  ),
];

export function gatewayProblem(driver: string, gateway: ProviderGatewayConfig): string | null {
  if (driver !== "codex" && driver !== "claudeAgent")
    return "Custom gateways currently support Claude Code and Codex.";
  if (gateway.protocol !== (driver === "codex" ? "responses" : "anthropic"))
    return "The gateway must support this agent's native protocol. Protocol conversion is not supported.";
  try {
    const url = new URL(gateway.baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return "Use an HTTP(S) base URL without credentials, query parameters or a fragment.";
  } catch {
    return "Enter a valid gateway base URL.";
  }
  if (!gateway.model.trim()) return "Enter a default model ID.";
  const names = new Set<string>();
  for (const header of gateway.headers) {
    const name = header.name.toLowerCase();
    if (
      names.has(name) ||
      [
        "authorization",
        "x-api-key",
        "host",
        "content-type",
        "content-length",
        "connection",
        "transfer-encoding",
        "anthropic-version",
      ].includes(name)
    )
      return "Header names must be unique and must not replace authentication or protocol headers.";
    names.add(name);
  }
  return null;
}

export function gatewayHeaders(
  gateway: ProviderGatewayConfig,
  environment: ProviderInstanceEnvironment,
): Record<string, string> {
  const values = new Map(environment.map((row) => [row.name, row.value]));
  const key = values.get(GATEWAY_KEY);
  if (!key?.trim()) throw new Error("Enter a gateway API key.");
  if (/[\r\n]/.test(key)) throw new Error("Credentials must not contain line breaks.");
  const headers: Array<[string, string]> =
    gateway.auth === "bearer" ? [["Authorization", `Bearer ${key}`]] : [["x-api-key", key]];
  for (const header of gateway.headers) {
    const value = values.get(header.variable);
    if (value === undefined || /[\r\n]/.test(value))
      throw new Error("Provide a single-line value for each custom header.");
    headers.push([header.name, value]);
  }
  return Object.fromEntries(headers);
}

export const emptyGateway = (driver: string): ProviderGatewayConfig => ({
  enabled: false,
  protocol: driver === "codex" ? "responses" : "anthropic",
  baseUrl: "",
  auth: "bearer",
  model: "",
  models: [],
  roles: {},
  headers: [],
});

/** Drop only gateway-owned secrets. Native auth/config and unrelated variables round-trip. */
export function withoutGateway(instance: ProviderInstanceConfig): ProviderInstanceConfig {
  const { gateway: _gateway, ...rest } = instance;
  return {
    ...rest,
    environment: instance.environment?.filter((row) => !isGatewayVariable(row.name)) ?? [],
  };
}
