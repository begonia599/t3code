import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { providerLoginView, supportsProviderLogin } from "./providerLogin.ts";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-test"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.160.0",
  status: "ready",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-10-04T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: false },
};
const idle: ProviderAuthState = {
  instanceId: provider.instanceId,
  phase: "idle",
  flowId: null,
  authorizationUrl: null,
  expiresAt: null,
  message: null,
};
const waiting: ProviderAuthState = {
  ...idle,
  phase: "waiting",
  flowId: "flow-1",
  interaction: {
    type: "deviceCode",
    id: "flow-1",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
  },
};

describe("Provider login presentation across clients", () => {
  it("offers login only after loading a capable, enabled instance", () => {
    expect(providerLoginView(provider, null).canStart).toBe(false);
    expect(providerLoginView({ ...provider, enabled: false }, idle).canStart).toBe(false);
    expect(providerLoginView({ ...provider, setup: undefined }, idle).canStart).toBe(false);
    expect(providerLoginView(provider, idle).canStart).toBe(true);
  });
  it("keeps managed Codex on its own login flow", () => {
    expect(supportsProviderLogin("codex", { setupMode: "managed" })).toBe(false);
    expect(supportsProviderLogin("codex", { setupMode: "existing" })).toBe(true);
    expect(supportsProviderLogin("codex")).toBe(true);
    expect(supportsProviderLogin("claudeAgent")).toBe(true);
    expect(supportsProviderLogin("grok")).toBe(true);
    expect(supportsProviderLogin("openCode")).toBe(false);
  });
  it("does not treat a past successful login as a currently authenticated account", () => {
    const state: ProviderAuthState = { ...idle, phase: "succeeded", message: "Signed in." };
    const stale = providerLoginView(provider, state);
    expect(stale.canStart).toBe(true);
    expect(stale.canLogout).toBe(false);
    expect(stale.message).toBe(
      "Sign-in completed. Refresh provider status to confirm the account.",
    );
    const refreshed = providerLoginView({ ...provider, auth: { status: "authenticated" } }, state);
    expect(refreshed.message).toBe("Signed in.");
    expect(refreshed.canLogout).toBe(true);
  });
  it("preserves an existing account and offers explicit logout", () => {
    const view = providerLoginView({ ...provider, auth: { status: "authenticated" } }, idle);
    expect(view.canStart).toBe(false);
    expect(view.canLogout).toBe(true);
  });
  it("shows the code only while this client owns the pending interaction", () => {
    const view = providerLoginView(provider, waiting);
    expect(view.deviceCode?.userCode).toBe("ABCD-1234");
    expect(view.canStart).toBe(false);
    expect(view.canCancel).toBe(true);
    const other = providerLoginView(provider, { ...waiting, flowId: null, interaction: null });
    expect(other.deviceCode).toBeNull();
    expect(other.canStart).toBe(false);
    expect(other.canCancel).toBe(false);
  });
  it.each(["verifying", "succeeded", "cancelled", "failed"] as const)(
    "removes a stale code in phase %s",
    (phase) => {
      expect(providerLoginView(provider, { ...waiting, phase }).deviceCode).toBeNull();
    },
  );
  it("removes codes if the instance loses login capability", () => {
    expect(providerLoginView({ ...provider, enabled: false }, waiting).deviceCode).toBeNull();
  });
  it("shows Claude's code entry only for the active interaction", () => {
    const state: ProviderAuthState = {
      ...waiting,
      interaction: {
        type: "authorizationCode",
        id: "one",
        url: "https://claude.ai/oauth/authorize?fixture",
      },
    };
    const view = providerLoginView(provider, state);
    expect(view.authorizationUrl).toBe(
      state.interaction!.type === "authorizationCode" ? state.interaction!.url : null,
    );
    expect(view.authorizationCode).toBe(state.interaction);
    expect(view.deviceCode).toBeNull();
    expect(
      providerLoginView(provider, { ...state, phase: "verifying" }).authorizationCode,
    ).toBeNull();
    expect(
      providerLoginView(provider, { ...state, interaction: null, flowId: null }).authorizationUrl,
    ).toBeNull();
  });
});
