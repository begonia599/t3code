import { describe, it, expect } from "vite-plus/test";
import { ProviderDriverKind, type ProviderInstanceConfig } from "@t3tools/contracts";
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
  it("keeps a saved key and unrelated fields when editing gateway values", () => {
    const draft = createGatewayDraft(instance);
    draft.gateway = {
      ...draft.gateway,
      enabled: true,
      baseUrl: "https://router.example/api/",
      model: "vendor/main",
    };
    draft.modelText = "vendor/a\nvendor/a, vendor/b";
    const next = buildGatewayInstance(instance, draft);
    expect(next.gateway).toMatchObject({
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
});
