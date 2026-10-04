import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { sandboxSettingsInstances, sandboxSettingsPatch } from "./provider-execution";

describe("mobile sandbox configuration", () => {
  it("includes legacy providers and retains custom account settings", () => {
    const id = ProviderInstanceId.make("claude-work");
    const instance = {
      driver: ProviderDriverKind.make("claudeAgent"),
      config: { homePath: "/private/work" },
    };
    const instances = sandboxSettingsInstances({
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: { [id]: instance },
    });
    expect(instances[id]).toBe(instance);
    expect(instances[ProviderInstanceId.make("codex")]?.config).toBe(
      DEFAULT_SERVER_SETTINGS.providers.codex,
    );
    expect(instances[ProviderInstanceId.make("grok")]).toBeDefined();
  });

  it("preserves other instances when enabling or clearing a sandbox", () => {
    const id = ProviderInstanceId.make("claude-work");
    const peerId = ProviderInstanceId.make("codex-personal");
    const peer = {
      driver: ProviderDriverKind.make("codex"),
      environment: [{ name: "VENDOR_OPTION", value: "", sensitive: true, valueRedacted: true }],
    };
    const instance = {
      driver: ProviderDriverKind.make("claudeAgent"),
      execution: { mode: "linux-sandbox" as const, profile: "work" },
    };
    const settings = { providerInstances: { [id]: instance, [peerId]: peer } };
    const patch = sandboxSettingsPatch(settings, id, { driver: instance.driver });
    expect(patch.providerInstances?.[peerId]).toBe(peer);
    expect(patch.providerInstances?.[id]?.execution).toBeUndefined();
    expect(settings.providerInstances[id]).toBe(instance);
  });
});
