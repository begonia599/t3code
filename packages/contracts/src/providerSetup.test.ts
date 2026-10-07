import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ProviderAuthResponse, ProviderAuthState } from "./providerSetup.ts";

const decodeResponse = Schema.decodeUnknownSync(ProviderAuthResponse);
const decodeState = Schema.decodeUnknownSync(ProviderAuthState);

describe("provider credential responses", () => {
  it("bounds the authorization code accepted over RPC", () => {
    expect(decodeResponse({ type: "authorizationCode", code: "fixture-code#state" })).toEqual({
      type: "authorizationCode",
      code: "fixture-code#state",
    });
    expect(() => decodeResponse({ type: "authorizationCode", code: " " })).toThrow();
    expect(() => decodeResponse({ type: "authorizationCode", code: "x".repeat(4097) })).toThrow();
  });
  it("accepts the advertised field limit and rejects oversized or invalid fields", () => {
    const values = Object.fromEntries(
      Array.from({ length: 16 }, (_, i) => [`field_${i}`, "value"]),
    );
    expect(decodeResponse({ type: "credentials", values })).toEqual({
      type: "credentials",
      values,
    });
    expect(() =>
      decodeResponse({ type: "credentials", values: { ...values, extra: "value" } }),
    ).toThrow();
    expect(() => decodeResponse({ type: "credentials", values: { "": "value" } })).toThrow();
    expect(() =>
      decodeResponse({ type: "credentials", values: { token: "x".repeat(16_385) } }),
    ).toThrow();
  });
});

describe("provider auth state", () => {
  it("preserves the native authorization-code interaction across the wire", () => {
    const interaction = {
      type: "authorizationCode",
      id: "flow",
      url: "https://claude.ai/oauth/authorize?fixture",
    };
    const state = decodeState({
      instanceId: "claudeAgent",
      phase: "waiting",
      flowId: "flow",
      authorizationUrl: interaction.url,
      expiresAt: null,
      message: null,
      interaction,
      credentialOwner: "provider",
    });
    expect(state.interaction).toEqual(interaction);
    expect(state.credentialOwner).toBe("provider");
  });
  it("drops auth variants from newer servers instead of rejecting the state", () => {
    const method = { id: "browser", name: "Browser", description: null, type: "agent" };
    expect(
      decodeState({
        instanceId: "cursor",
        phase: "waiting",
        flowId: null,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
        methods: [method, { ...method, id: "passkey", type: "passkey" }],
        interaction: { type: "passkey", id: "passkey" },
        credentialOwner: "keychain",
      }),
    ).toEqual({
      instanceId: "cursor",
      phase: "waiting",
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [method],
    });
  });
});
