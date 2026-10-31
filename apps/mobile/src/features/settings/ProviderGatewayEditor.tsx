import {
  addGatewayHeader,
  buildGatewayInstance,
  createGatewayDraft,
  gatewayEditorKey,
  gatewayLabels,
} from "@t3tools/client-runtime/provider-gateway";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ProviderInstanceConfig,
  ProviderInstanceConfigMap,
  ProviderGatewayProbeResult,
} from "@t3tools/contracts";
import { withoutGateway } from "@t3tools/shared/providerGateway";
import { useRef, useState } from "react";
import { Modal, ScrollView, Switch, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { useMobileT } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";

interface Props {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  instance: ProviderInstanceConfig;
  instances: ProviderInstanceConfigMap;
  readOnly: boolean;
}

export function ProviderGatewayEditorButton(props: Props) {
  const t = useMobileT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <SettingsActionRow
        icon="slider.horizontal.3"
        label={t("Custom API gateway")}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <GatewayEditor
          key={gatewayEditorKey(props.instance)}
          {...props}
          close={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function GatewayEditor({
  environmentId,
  instanceId,
  instance,
  instances,
  readOnly,
  close,
}: Props & { close: () => void }) {
  const t = useMobileT();
  const insets = useSafeAreaInsets();
  const [draft, updateDraft] = useState(() => createGatewayDraft(instance));
  const [modelQuery, setModelQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProviderGatewayProbeResult | null>(null);
  const setDraft: typeof updateDraft = (next) => {
    setResult(null);
    updateDraft(next);
  };
  const probe = useAtomCommand(serverEnvironment.providerGatewayProbe, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const disabled = readOnly || busy;
  const field = (
    label: string,
    value: string,
    set: (text: string) => void,
    secret = false,
    placeholder = "",
    multiline = false,
  ) => (
    <View className="gap-1">
      <Text className="text-sm text-foreground">{t(label)}</Text>
      <TextInput
        accessibilityLabel={t(label)}
        className="rounded-lg border border-border p-3 text-foreground"
        value={value}
        onChangeText={(value) => {
          set(value);
        }}
        editable={!disabled}
        secureTextEntry={secret}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        multiline={multiline}
        style={multiline ? { minHeight: 100, maxHeight: 160 } : undefined}
      />
    </View>
  );
  async function run(action: "models" | "test" | "save" | "remove") {
    if (pending.current || readOnly) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const forAction =
        action === "models" && !draft.gateway.model.trim()
          ? { ...draft, gateway: { ...draft.gateway, model: "model-list" } }
          : draft;
      const next =
        action === "remove" ? withoutGateway(instance) : buildGatewayInstance(instance, forAction);
      if (action === "save" || action === "remove") {
        const response = await update({
          environmentId,
          input: { patch: { providerInstances: { ...instances, [instanceId]: next } } },
        });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        close();
      } else {
        const response = await probe({
          environmentId,
          input: {
            instanceId,
            gateway: next.gateway!,
            environment: next.environment ?? [],
            action,
          },
        });
        if (response._tag === "Failure") throw squashAtomCommandFailure(response);
        if (action === "models" && response.value.models.length)
          setDraft((current) => ({ ...current, modelText: response.value.models.join("\n") }));
        setResult(response.value);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update gateway settings.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      animationType="slide"
      onRequestClose={() => {
        if (!busy) close();
      }}
    >
      <ScrollView
        className="bg-background"
        contentContainerStyle={{
          padding: 16,
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 16,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="gap-4">
          <Text className="text-xl font-t3-semibold text-foreground">
            {t("Custom API gateway")}
          </Text>
          <Text className="text-sm text-foreground-muted">{t(gatewayLabels.help)}</Text>
          <View className="flex-row items-center justify-between">
            <Text className="text-foreground">{t("Enable custom gateway")}</Text>
            <Switch
              accessibilityLabel={t("Enable custom gateway")}
              disabled={disabled}
              value={draft.gateway.enabled}
              onValueChange={(enabled) =>
                setDraft({ ...draft, gateway: { ...draft.gateway, enabled } })
              }
            />
          </View>
          <Text className="text-sm text-foreground">
            {t("Native protocol")}:{" "}
            {draft.gateway.protocol === "anthropic" ? "Anthropic Messages" : "OpenAI Responses"}
          </Text>
          {instance.driver === "claudeAgent" ? (
            <MaterialButton
              label={t("Use OpenRouter address")}
              disabled={disabled}
              onPress={() =>
                setDraft({
                  ...draft,
                  gateway: {
                    ...draft.gateway,
                    baseUrl: "https://openrouter.ai/api",
                    auth: "bearer",
                  },
                })
              }
            />
          ) : null}
          {field("Gateway base URL", draft.gateway.baseUrl, (baseUrl) =>
            setDraft({ ...draft, gateway: { ...draft.gateway, baseUrl } }),
          )}
          <Text className="text-sm text-foreground-muted">{t(gatewayLabels.baseHelp)}</Text>
          <Text className="text-sm text-foreground">
            {t("Gateway authentication")}: {draft.gateway.auth}
          </Text>
          <View className="flex-row gap-2">
            {(["bearer", "api-key"] as const).map((auth) => (
              <MaterialButton
                key={auth}
                label={auth === "bearer" ? "Bearer token" : "x-api-key"}
                disabled={disabled}
                onPress={() => setDraft({ ...draft, gateway: { ...draft.gateway, auth } })}
              />
            ))}
          </View>
          {field(
            "Gateway API key",
            draft.key.value,
            (value) => setDraft({ ...draft, key: { ...draft.key, value, valueRedacted: false } }),
            true,
            draft.key.valueRedacted ? t("Saved; leave unchanged to keep") : "",
          )}
          {field("Default model ID", draft.gateway.model, (model) =>
            setDraft({ ...draft, gateway: { ...draft.gateway, model } }),
          )}
          <MaterialButton
            label={t("Load gateway models")}
            disabled={disabled}
            onPress={() => void run("models")}
          />
          {result?.models.length ? field("Filter models", modelQuery, setModelQuery) : null}
          {result?.models
            .filter((model) => model.toLowerCase().includes(modelQuery.toLowerCase()))
            .slice(0, 12)
            .map((model) => (
              <MaterialButton
                key={model}
                label={model}
                disabled={disabled}
                onPress={() => setDraft({ ...draft, gateway: { ...draft.gateway, model } })}
              />
            ))}
          {field(
            "Additional model IDs",
            draft.modelText,
            (modelText) => setDraft({ ...draft, modelText }),
            false,
            "",
            true,
          )}
          <Text className="text-sm text-foreground-muted">{t(gatewayLabels.modelsHelp)}</Text>
          {instance.driver === "claudeAgent" ? (
            <View className="gap-3">
              <Text className="text-foreground">{t("Claude model mapping")}</Text>
              {(["opus", "sonnet", "haiku", "subagent"] as const).map((role) => (
                <View key={role}>
                  {field(
                    role,
                    draft.gateway.roles[role] ?? "",
                    (value) => {
                      const roles = { ...draft.gateway.roles };
                      if (value.trim()) roles[role] = value.trim();
                      else delete roles[role];
                      setDraft({ ...draft, gateway: { ...draft.gateway, roles } });
                    },
                    false,
                    draft.gateway.model,
                  )}
                </View>
              ))}
            </View>
          ) : null}
          <Text className="text-foreground">{t("Custom request headers")}</Text>
          {draft.headers.map((header, index) => (
            <View key={header.credential.name} className="gap-2">
              {field("Header name", header.name, (name) =>
                setDraft({
                  ...draft,
                  headers: draft.headers.map((item, i) => (i === index ? { ...item, name } : item)),
                }),
              )}
              {field(
                "Header value",
                header.credential.value,
                (value) =>
                  setDraft({
                    ...draft,
                    headers: draft.headers.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            credential: { ...item.credential, value, valueRedacted: false },
                          }
                        : item,
                    ),
                  }),
                true,
                header.credential.valueRedacted ? t("Saved; leave unchanged to keep") : "",
              )}
              <MaterialButton
                label={t("Remove header")}
                disabled={disabled}
                onPress={() =>
                  setDraft({ ...draft, headers: draft.headers.filter((_, i) => i !== index) })
                }
              />
            </View>
          ))}
          <MaterialButton
            label={t("Add header")}
            disabled={disabled || draft.headers.length >= 20}
            onPress={() => setDraft(addGatewayHeader(draft))}
          />
          <Text className="text-sm text-foreground-muted">{t(gatewayLabels.testHelp)}</Text>
          <MaterialButton
            label={t("Test connection")}
            disabled={disabled}
            onPress={() => void run("test")}
          />
          {result?.checks.map((check) => (
            <Text key={check.name} className="text-sm text-foreground">
              {check.ok ? "✓" : "✗"} {t(check.name)}: {t(check.detail)}
            </Text>
          ))}
          <Text className="text-sm text-foreground-muted">{t(gatewayLabels.saveHelp)}</Text>
          <MaterialButton
            label={t("Save gateway")}
            disabled={disabled}
            onPress={() => void run("save")}
          />
          {instance.gateway ? (
            <MaterialButton
              label={t("Remove gateway")}
              disabled={disabled}
              onPress={() => void run("remove")}
            />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {t(error)}
            </Text>
          ) : null}
          <MaterialButton label={t("Close")} disabled={busy} onPress={close} />
        </View>
      </ScrollView>
    </Modal>
  );
}
