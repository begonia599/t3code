import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";

/** Include the default providers before any explicit instances have been saved. */
export function sandboxSettingsInstances(
  settings: Pick<ServerSettings, "providers" | "providerInstances">,
): ProviderInstanceConfigMap {
  const instances = { ...settings.providerInstances };
  for (const driver of ["claudeAgent", "codex", "grok"] as const) {
    const kind = ProviderDriverKind.make(driver);
    const id = defaultInstanceIdForDriver(kind);
    instances[id] ??= { driver: kind, config: settings.providers[driver] };
  }
  return instances;
}

/** The settings contract replaces the complete instance map on each write. */
export function sandboxSettingsPatch(
  settings: Pick<ServerSettings, "providerInstances">,
  instanceId: ProviderInstanceId,
  instance: ProviderInstanceConfig,
): ServerSettingsPatch {
  return { providerInstances: { ...settings.providerInstances, [instanceId]: instance } };
}
