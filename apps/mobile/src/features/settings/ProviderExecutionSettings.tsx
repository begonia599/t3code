import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderInstanceExecution,
  supportsProviderSandbox,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import { useRef, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useMobileT } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { sandboxSettingsInstances, sandboxSettingsPatch } from "./provider-execution";

const isExecution = Schema.is(ProviderInstanceExecution);

function ProfileField(props: {
  readonly value: string;
  readonly disabled: boolean;
  readonly onSave: (value: string) => void;
}) {
  const t = useMobileT();
  const [value, setValue] = useState(props.value);
  return (
    <View className="gap-2 px-4 pb-4">
      <Text className="text-sm text-foreground-muted">{t("Sandbox profile")}</Text>
      <TextInput
        accessibilityLabel={t("Sandbox profile")}
        value={value}
        onChangeText={setValue}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        maxLength={64}
        className="rounded-lg border border-border px-3 py-2 text-foreground"
      />
      <Pressable
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={() => props.onSave(value)}
      >
        <Text className="text-primary">{t("Save")}</Text>
      </Pressable>
      <Text className="text-sm text-foreground-muted">
        {t(
          "The host profile controls shared folders, tools and network routing. Provider environment values remain readable inside the sandbox.",
        )}
      </Text>
    </View>
  );
}

export function ProviderExecutionSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
}) {
  const t = useMobileT();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  if (!settings) return null;
  const instances = Object.entries(sandboxSettingsInstances(settings)).filter(([, instance]) =>
    supportsProviderSandbox(instance.driver),
  );
  if (instances.length === 0) return null;
  const disabled = props.disabled || pending;
  async function save(instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) {
    if (props.disabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (!settings) return;
      const result = await update({
        environmentId: props.environmentId,
        input: { patch: sandboxSettingsPatch(settings, instanceId, instance) },
      });
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
    } catch (cause) {
      Alert.alert(
        t("Execution environment"),
        cause instanceof Error ? cause.message : t("Could not save sandbox settings."),
      );
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }
  return (
    <SettingsSection title="Execution environment">
      {instances.map(([rawId, instance]) => {
        const instanceId = rawId as ProviderInstanceId;
        return (
          <View key={instanceId}>
            <SettingsSwitchRow
              icon="server.rack"
              label={instance.displayName ?? instanceId}
              subtitle={t("Linux sandbox")}
              disabled={disabled}
              value={instance.execution !== undefined}
              onValueChange={(enabled) => {
                if (enabled) {
                  void save(instanceId, {
                    ...instance,
                    execution: { mode: "linux-sandbox", profile: instanceId },
                  });
                } else {
                  const { execution: _execution, ...next } = instance;
                  void save(instanceId, next);
                }
              }}
            />
            {instance.execution ? (
              <ProfileField
                key={instance.execution.profile}
                value={instance.execution.profile}
                disabled={disabled}
                onSave={(profile) => {
                  const execution = { mode: "linux-sandbox", profile: profile.trim() };
                  if (isExecution(execution)) {
                    void save(instanceId, { ...instance, execution });
                  } else {
                    Alert.alert(
                      t("Invalid sandbox profile"),
                      t(
                        "Use a letter followed by letters, numbers, underscores or hyphens (up to 64 characters).",
                      ),
                    );
                  }
                }}
              />
            ) : null}
          </View>
        );
      })}
    </SettingsSection>
  );
}
