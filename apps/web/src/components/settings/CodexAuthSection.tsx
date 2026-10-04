import { codexDeviceAuthView } from "@t3tools/client-runtime/codex-device-auth";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useT } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function CodexAuthSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
}) {
  const t = useT();
  const target = { environmentId: props.environmentId, input: { instanceId: props.instanceId } };
  const available = !props.readOnly && props.provider?.setup?.canAuthenticate === true;
  const query = useEnvironmentQuery(available ? serverEnvironment.providerAuthState(target) : null);
  const state = query.data;
  const view = codexDeviceAuthView(props.provider, state);
  const commandOptions = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedFlow, setCopiedFlow] = useState<string | null>(null);
  const disabled = props.readOnly || pending || query.error !== null;

  async function run<A, E>(action: () => Promise<AtomCommandResult<A, E>>) {
    if (pendingRef.current || props.readOnly) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "Could not update Codex sign-in. Try again.",
        );
      }
    } catch {
      setError("Could not update Codex sign-in. Try again.");
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  async function openAuthorization() {
    if (!view.deviceCode) return;
    try {
      await ensureLocalApi().shell.openExternal(view.deviceCode.url);
    } catch {
      setError("Could not open the sign-in page. Open the displayed link in your browser.");
    }
  }

  async function copyCode() {
    if (!view.deviceCode) return;
    try {
      await writeTextToClipboard(view.deviceCode.userCode, "Codex sign-in code");
      setCopiedFlow(state?.flowId ?? null);
    } catch {
      setError("Could not copy the code. Enter the displayed code manually.");
    }
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `${t("Sign out of Codex?")}\n${props.environmentLabel} · ${props.provider?.displayName ?? props.instanceId}\n${t("This stops running threads using this sign-in. Thread history is kept.")}`,
    );
    if (confirmed) await run(() => logout(target));
  }

  return (
    <SettingsRow
      title={t("Codex account")}
      description={t("Authorize this instance in your browser without SSH.")}
    >
      <div className="grid gap-3 pb-3">
        <p className="text-xs text-muted-foreground">
          {props.environmentLabel} · {props.provider?.displayName ?? props.instanceId}
        </p>
        <p role="status" className="text-sm">
          {t(props.readOnly ? "Provider setup is read-only." : view.message)}
        </p>
        {view.deviceCode && !props.readOnly ? (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              {t("Open the authorization page and enter this one-time code.")}
            </p>
            <code className="select-all text-lg tracking-widest">{view.deviceCode.userCode}</code>
            <p className="break-all text-xs text-muted-foreground">{view.deviceCode.url}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void openAuthorization()}>
                {t("Open authorization page")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void copyCode()}>
                {t(copiedFlow === state?.flowId ? "Code copied" : "Copy code")}
              </Button>
            </div>
            {state?.expiresAt ? (
              <p className="text-xs text-muted-foreground">
                {t("Expires at")}{" "}
                <time dateTime={state.expiresAt}>
                  {new Date(state.expiresAt).toLocaleTimeString()}
                </time>
              </p>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {view.canStart ? (
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || !props.provider?.installed}
              onClick={() => void run(() => start(target))}
            >
              {t(
                state?.phase === "failed" || state?.phase === "cancelled"
                  ? "Retry sign-in"
                  : "Sign in with ChatGPT",
              )}
            </Button>
          ) : null}
          {view.canCancel && state?.flowId ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() =>
                void run(() =>
                  cancel({ ...target, input: { ...target.input, flowId: state.flowId! } }),
                )
              }
            >
              {t("Cancel sign-in")}
            </Button>
          ) : null}
          {view.canLogout ? (
            <Button size="sm" variant="outline" disabled={disabled} onClick={() => void signOut()}>
              {t("Sign out")}
            </Button>
          ) : null}
          {query.error ? (
            <Button size="sm" variant="outline" onClick={query.refresh}>
              {t("Retry setup status")}
            </Button>
          ) : null}
        </div>
        {error || query.error ? (
          <p role="alert" className="text-sm text-destructive">
            {t(error ?? query.error ?? "")}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
