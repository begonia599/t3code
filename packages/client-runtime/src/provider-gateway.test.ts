import { describe, it, expect } from "vite-plus/test";
import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
import { withoutGateway } from "@t3tools/shared/providerGateway";
import { addGatewayHeader, buildGatewayInstance, createGatewayDraft } from "./provider-gateway.ts";

const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("claudeAgent"),
  config: { homePath: "/original", customModels: ["original-model"] },
  environment: [
    { name: "T3_GATEWAY_API_KEY", value: "", valueRedacted: true, sensitive: true },
    { name: "HTTPS_PROXY", value: "http://proxy", sensitive: false },
  ],
};

describe("gateway editor", () => {
  it("applies the gateway on save while keeping a saved key and unrelated fields", () => {
    const draft = createGatewayDraft(instance);
    draft.gateway = {
      ...draft.gateway,
      baseUrl: "https://router.example/api/",
      model: "vendor/main",
    };
    draft.modelText = "vendor/a\nvendor/a, vendor/b";
    const next = buildGatewayInstance(instance, draft);
    expect(next.gateway).toMatchObject({
      enabled: true,
      baseUrl: "https://router.example/api",
      models: ["vendor/a", "vendor/b"],
      protocol: "anthropic",
    });
    expect(next.environment).toContainEqual(instance.environment![0]);
    expect(next.environment).toContainEqual(instance.environment![1]);
    expect(next.config).toEqual(instance.config);
  });
  it("replaces a credential only when explicitly entered and stores custom headers as secrets", () => {
    let draft = createGatewayDraft(instance);
    draft.gateway = { ...draft.gateway, baseUrl: "http://local-gateway:8080", model: "local" };
    draft.key = { ...draft.key, value: "new-secret", valueRedacted: false };
    draft = addGatewayHeader(draft);
    draft.headers[0] = {
      name: "X-Tenant",
      credential: { ...draft.headers[0]!.credential, value: "tenant-token", sensitive: false },
    };
    const next = buildGatewayInstance(instance, draft);
    expect(next.environment).toContainEqual({
      name: "T3_GATEWAY_API_KEY",
      value: "new-secret",
      valueRedacted: false,
      sensitive: true,
    });
    expect(next.environment).toContainEqual({
      name: "T3_GATEWAY_HEADER_0",
      value: "tenant-token",
      sensitive: true,
    });
    expect(next.gateway?.headers).toEqual([{ name: "X-Tenant", variable: "T3_GATEWAY_HEADER_0" }]);
    expect(JSON.stringify(next.gateway)).not.toContain("tenant-token");
  });
  it("does not enable a gateway without explicit credentials or invent a compatible protocol", () => {
    const draft = createGatewayDraft({ ...instance, environment: [] });
    draft.gateway = { ...draft.gateway, baseUrl: "https://gateway.example", model: "local" };
    expect(() => buildGatewayInstance(instance, draft)).toThrow(/API key/);
    draft.key = { ...draft.key, value: "key" };
    draft.gateway = { ...draft.gateway, protocol: "responses" };
    expect(() => buildGatewayInstance(instance, draft)).toThrow(/native protocol/);
  });
  it("applies a previously disabled gateway without resetting advanced settings", () => {
    const draft = createGatewayDraft(instance);
    const existing = {
      ...instance,
      gateway: {
        ...draft.gateway,
        enabled: false,
        baseUrl: "https://gateway.example",
        model: "main",
        auth: "api-key" as const,
        roles: { haiku: "small" },
      },
    };
    const next = buildGatewayInstance(existing, createGatewayDraft(existing));
    expect(next.gateway).toEqual({ ...existing.gateway, enabled: true });
    expect(existing.gateway.enabled).toBe(false);
    const restored = withoutGateway(next);
    expect(restored.gateway).toBeUndefined();
    expect(restored.config).toEqual(instance.config);
    expect(restored.environment).toEqual([instance.environment![1]]);
  });
  it("validates the address and model before applying and still rejects managed Codex", () => {
    const draft = createGatewayDraft(instance);
    expect(() => buildGatewayInstance(instance, draft)).toThrow(/base URL/);
    draft.gateway = { ...draft.gateway, baseUrl: "https://gateway.example" };
    expect(() => buildGatewayInstance(instance, draft)).toThrow(/default model/);
    const managed = {
      ...instance,
      driver: ProviderDriverKind.make("codex"),
      config: { setupMode: "managed" },
    };
    const codexDraft = createGatewayDraft(managed);
    codexDraft.gateway = {
      ...codexDraft.gateway,
      baseUrl: "https://gateway.example/v1",
      model: "main",
    };
    expect(() => buildGatewayInstance(managed, codexDraft)).toThrow(/local Codex runtime/);
  });
});
