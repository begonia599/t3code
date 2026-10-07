import {
  providerLoginView,
  providerLoginLabels,
  type LoginProvider,
} from "@t3tools/client-runtime/provider-login";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useRef, useState } from "react";
import { Alert, Linking, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/AppText";
import { useMobileT } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSection } from "./components/SettingsSection";

export function ProviderLoginSettings(props: {
  readonly environmentId: EnvironmentId;
  readonly provider: ServerProvider;
  readonly disabled: boolean;
  readonly driver: LoginProvider;
}) {
  const t = useMobileT();
  const labels = providerLoginLabels[props.driver];
  const target = {
    environmentId: props.environmentId,
    input: { instanceId: props.provider.instanceId },
  };
  const query = useEnvironmentQuery(
    !props.disabled && props.provider.setup?.canAuthenticate
      ? serverEnvironment.providerAuthState(target)
      : null,
  );
  const state = query.data;
  const view = providerLoginView(props.provider, state);
  const commandOptions = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, commandOptions);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commandOptions);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedFlow, setCopiedFlow] = useState<string | null>(null);
  const disabled = props.disabled || pending || query.error !== null;

  async function run<A, E>(action: () => Promise<AtomCommandResult<A, E>>) {
    if (pendingRef.current || props.disabled) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "Could not update sign-in. Try again.",
        );
      }
    } catch {
      setError("Could not update sign-in. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  function signOut() {
    Alert.alert(
      t(labels.signOut),
      `${props.provider.displayName ?? props.provider.instanceId}\n${t("This stops running threads using this sign-in. Thread history is kept.")}`,
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Sign out"),
          style: "destructive",
          onPress: () => void run(() => logout(target)),
        },
      ],
    );
  }

  return (
    <SettingsSection
      title={`${t(labels.account)} · ${props.provider.displayName ?? props.provider.instanceId}`}
    >
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground-muted">
          {t("Authorize this instance in your browser without SSH.")}
        </Text>
        <Text accessibilityLiveRegion="polite" className="text-foreground">
          {t(props.disabled ? "Provider setup is read-only." : view.message)}
        </Text>
        {view.authorizationUrl && !props.disabled ? (
          <>
            <Text className="text-sm text-foreground-muted">
              {t(
                view.authorizationCode
                  ? "Open the authorization page, then paste the code it gives you below."
                  : "Open the authorization page and enter this one-time code.",
              )}
            </Text>
            {view.deviceCode ? (
              <Text selectable className="text-xl font-semibold text-foreground">
                {view.deviceCode.userCode}
              </Text>
            ) : null}
            <Text selectable className="text-sm text-foreground-muted">
              {view.authorizationUrl}
            </Text>
            {state?.expiresAt ? (
              <Text className="text-sm text-foreground-muted">
                {t("Expires at")} {new Date(state.expiresAt).toLocaleTimeString()}
              </Text>
            ) : null}
          </>
        ) : null}
        {error || query.error ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {t(error ?? query.error ?? "")}
          </Text>
        ) : null}
      </View>
      {view.authorizationUrl && !props.disabled ? (
        <>
          <SettingsActionRow
            icon="arrow.up.right"
            label={t("Open authorization page")}
            onPress={() => {
              if (view.authorizationUrl)
                void Linking.openURL(view.authorizationUrl).catch(() =>
                  setError(
                    "Could not open the sign-in page. Open the displayed link in your browser.",
                  ),
                );
            }}
          />
          {view.deviceCode ? (
            <SettingsActionRow
              icon="doc.on.doc"
              label={t(copiedFlow === state?.flowId ? "Code copied" : "Copy code")}
              onPress={() => {
                if (view.deviceCode)
                  void Clipboard.setStringAsync(view.deviceCode.userCode)
                    .then(() => setCopiedFlow(state?.flowId ?? null))
                    .catch(() =>
                      setError("Could not copy the code. Enter the displayed code manually."),
                    );
              }}
            />
          ) : null}
        </>
      ) : null}
      {view.authorizationCode && state?.flowId && !props.disabled ? (
        <AuthorizationCodeInput
          key={state.flowId}
          disabled={disabled}
          onSubmit={(code) =>
            void run(() =>
              respond({
                ...target,
                input: {
                  ...target.input,
                  flowId: state.flowId!,
                  interactionId: view.authorizationCode!.id,
                  response: { type: "authorizationCode", code },
                },
              }),
            )
          }
        />
      ) : null}
      {view.canStart ? (
        <SettingsActionRow
          icon="person.crop.circle"
          label={t(
            state?.phase === "failed" ||
              state?.phase === "cancelled" ||
              state?.phase === "succeeded"
              ? "Retry sign-in"
              : labels.signIn,
          )}
          disabled={disabled || !props.provider.installed}
          loading={pending}
          onPress={() => void run(() => start(target))}
        />
      ) : null}
      {view.canCancel && state?.flowId ? (
        <SettingsActionRow
          icon="xmark"
          label={t("Cancel sign-in")}
          disabled={disabled}
          onPress={() =>
            void run(() => cancel({ ...target, input: { ...target.input, flowId: state.flowId! } }))
          }
        />
      ) : null}
      {view.canLogout ? (
        <SettingsActionRow
          icon="person.crop.circle"
          label={t("Sign out")}
          disabled={disabled}
          onPress={signOut}
        />
      ) : null}
      {view.available ? (
        <SettingsActionRow
          icon="arrow.clockwise"
          label={t("Refresh account status")}
          disabled={pending || view.active || props.disabled}
          onPress={() => void run(() => refresh(target))}
        />
      ) : null}
      {query.error ? (
        <SettingsActionRow
          icon="arrow.clockwise"
          label={t("Retry setup status")}
          onPress={query.refresh}
        />
      ) : null}
    </SettingsSection>
  );
}

function AuthorizationCodeInput(props: {
  readonly disabled: boolean;
  readonly onSubmit: (code: string) => void;
}) {
  const t = useMobileT();
  const [code, setCode] = useState("");
  return (
    <>
      <View className="gap-2 p-4">
        <Text className="text-sm text-foreground-muted">{t("Authorization code")}</Text>
        <AppTextInput
          accessibilityLabel={t("Authorization code")}
          secureTextEntry
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect={false}
          maxLength={4096}
          editable={!props.disabled}
          value={code}
          onChangeText={setCode}
          className="rounded-lg border border-border p-3 text-foreground"
        />
      </View>
      <SettingsActionRow
        icon="checkmark"
        label={t("Submit authorization code")}
        disabled={props.disabled || !code.trim()}
        onPress={() => {
          if (props.disabled || !code.trim()) return;
          props.onSubmit(code.trim());
          setCode("");
        }}
      />
    </>
  );
}
