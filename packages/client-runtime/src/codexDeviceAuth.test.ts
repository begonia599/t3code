import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { codexDeviceAuthView } from "./codexDeviceAuth.ts";

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

describe("Codex login presentation across clients", () => {
  it("offers login only after loading a capable, enabled instance", () => {
    expect(codexDeviceAuthView(provider, null).canStart).toBe(false);
    expect(codexDeviceAuthView({ ...provider, enabled: false }, idle).canStart).toBe(false);
    expect(codexDeviceAuthView({ ...provider, setup: undefined }, idle).canStart).toBe(false);
    expect(codexDeviceAuthView(provider, idle).canStart).toBe(true);
  });
  it("preserves an existing account and offers explicit logout", () => {
    const view = codexDeviceAuthView({ ...provider, auth: { status: "authenticated" } }, idle);
    expect(view.canStart).toBe(false);
    expect(view.canLogout).toBe(true);
  });
  it("shows the code only while this client owns the pending interaction", () => {
    const view = codexDeviceAuthView(provider, waiting);
    expect(view.deviceCode?.userCode).toBe("ABCD-1234");
    expect(view.canStart).toBe(false);
    expect(view.canCancel).toBe(true);
    const other = codexDeviceAuthView(provider, { ...waiting, flowId: null, interaction: null });
    expect(other.deviceCode).toBeNull();
    expect(other.canStart).toBe(false);
    expect(other.canCancel).toBe(false);
  });
  it.each(["verifying", "succeeded", "cancelled", "failed"] as const)(
    "removes a stale code in phase %s",
    (phase) => {
      expect(codexDeviceAuthView(provider, { ...waiting, phase }).deviceCode).toBeNull();
    },
  );
  it("removes codes if the instance loses login capability", () => {
    expect(codexDeviceAuthView({ ...provider, enabled: false }, waiting).deviceCode).toBeNull();
  });
});
