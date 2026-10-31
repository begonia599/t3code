import type {
  ProviderGatewayConfig,
  ProviderInstanceConfig,
  ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import {
  emptyGateway,
  gatewayProblem,
  GATEWAY_KEY,
  isGatewayVariable,
} from "@t3tools/shared/providerGateway";

export interface GatewayDraft {
  gateway: ProviderGatewayConfig;
  key: ProviderInstanceEnvironmentVariable;
  headers: Array<{ name: string; credential: ProviderInstanceEnvironmentVariable }>;
  modelText: string;
}

export function createGatewayDraft(instance: ProviderInstanceConfig): GatewayDraft {
  const gateway = instance.gateway ?? emptyGateway(instance.driver);
  const value = (name: string) =>
    instance.environment?.find((row) => row.name === name) ?? { name, value: "", sensitive: true };
  return {
    gateway,
    key: value(GATEWAY_KEY),
    headers: gateway.headers.map((header) => ({
      name: header.name,
      credential: value(header.variable),
    })),
    modelText: gateway.models.join("\n"),
  };
}

export function buildGatewayInstance(
  instance: ProviderInstanceConfig,
  draft: GatewayDraft,
): ProviderInstanceConfig {
  const gateway = {
    ...draft.gateway,
    enabled: true,
    baseUrl: draft.gateway.baseUrl.trim().replace(/\/+$/, ""),
    model: draft.gateway.model.trim(),
    models: [
      ...new Set(
        draft.modelText
          .split(/[\n,]/)
          .map((model) => model.trim())
          .filter(Boolean),
      ),
    ],
    headers: draft.headers.map((header) => ({
      name: header.name.trim(),
      variable: header.credential.name,
    })),
  };
  const problem = gatewayProblem(instance.driver, gateway);
  if (problem) throw new Error(problem);
  if (!draft.key.value.trim() && !draft.key.valueRedacted)
    throw new Error("Enter a gateway API key.");
  if (
    gateway.enabled &&
    instance.driver === "codex" &&
    instance.config &&
    typeof instance.config === "object" &&
    "setupMode" in instance.config &&
    instance.config.setupMode === "managed"
  )
    throw new Error("Select the local Codex runtime before enabling a custom gateway.");
  return {
    ...instance,
    gateway,
    environment: [
      ...(instance.environment ?? []).filter((row) => !isGatewayVariable(row.name)),
      { ...draft.key, sensitive: true },
      ...draft.headers.map((header) => ({ ...header.credential, sensitive: true })),
    ],
  };
}

export function addGatewayHeader(draft: GatewayDraft): GatewayDraft {
  let index = 0;
  while (draft.headers.some((header) => header.credential.name === `T3_GATEWAY_HEADER_${index}`))
    index++;
  return {
    ...draft,
    headers: [
      ...draft.headers,
      { name: "", credential: { name: `T3_GATEWAY_HEADER_${index}`, value: "", sensitive: true } },
    ],
  };
}

export const gatewayEditorKey = (instance: ProviderInstanceConfig) =>
  JSON.stringify([
    instance.gateway,
    instance.environment?.filter((row) => isGatewayVariable(row.name)),
  ]);

export const gatewayLabels = {
  saveHelp: "Saving applies this gateway to the instance and can stop its running tasks.",
  testHelp:
    "Tests run on the selected server and make two small, potentially billable requests. They check basic streaming and tool calls, not every agent capability.",
  baseHelp: {
    anthropic: "Base URL before /v1/messages. Include your gateway's path prefix.",
    responses: "Base URL before /responses. Include your gateway's path prefix.",
  },
  modelsHelp:
    "Model IDs are sent unchanged. Load the list or enter IDs manually, one per line. Existing chats may need a model from this gateway selected.",
} as const;
