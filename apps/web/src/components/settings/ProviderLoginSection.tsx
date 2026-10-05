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
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useId, useRef, useState } from "react";

import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { useT } from "../../i18n";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

export function ProviderLoginSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly driver: LoginProvider;
}) {
  const t = useT();
  const labels = providerLoginLabels[props.driver];
  const target = { environmentId: props.environmentId, input: { instanceId: props.instanceId } };
  const available = !props.readOnly && props.provider?.setup?.canAuthenticate === true;
  const query = useEnvironmentQuery(available ? serverEnvironment.providerAuthState(target) : null);
  const state = query.data;
  const view = providerLoginView(props.provider, state);
  const commandOptions = { reportFailure: false, reportDefect: false };
  const start = useAtomCommand(serverEnvironment.startProviderAuth, commandOptions);
  const cancel = useAtomCommand(serverEnvironment.cancelProviderAuth, commandOptions);
  const logout = useAtomCommand(serverEnvironment.logoutProviderAuth, commandOptions);
  const respond = useAtomCommand(serverEnvironment.respondProviderAuth, commandOptions);
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

  async function openAuthorization() {
    if (!view.authorizationUrl) return;
    try {
      await ensureLocalApi().shell.openExternal(view.authorizationUrl);
    } catch {
      setError("Could not open the sign-in page. Open the displayed link in your browser.");
    }
  }

  async function copyCode() {
    if (!view.deviceCode) return;
    try {
      await writeTextToClipboard(view.deviceCode.userCode, `${labels.name} sign-in code`);
      setCopiedFlow(state?.flowId ?? null);
    } catch {
      setError("Could not copy the code. Enter the displayed code manually.");
    }
  }

  async function signOut() {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      `${t(labels.signOut)}\n${props.environmentLabel} · ${props.provider?.displayName ?? props.instanceId}\n${t("This stops running threads using this sign-in. Thread history is kept.")}`,
    );
    if (confirmed) await run(() => logout(target));
  }

  return (
    <SettingsRow
      title={t(labels.account)}
      description={t("Authorize this instance in your browser without SSH.")}
    >
      <div className="grid gap-3 pb-3">
        <p className="text-xs text-muted-foreground">
          {props.environmentLabel} · {props.provider?.displayName ?? props.instanceId}
        </p>
        <p role="status" className="text-sm">
          {t(props.readOnly ? "Provider setup is read-only." : view.message)}
        </p>
        {view.authorizationUrl && !props.readOnly ? (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">
              {t(
                view.authorizationCode
                  ? "Open the authorization page, then paste the code it gives you below."
                  : "Open the authorization page and enter this one-time code.",
              )}
            </p>
            {view.deviceCode ? (
              <code className="select-all text-lg tracking-widest">{view.deviceCode.userCode}</code>
            ) : null}
            <p className="break-all text-xs text-muted-foreground">{view.authorizationUrl}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => void openAuthorization()}>
                {t("Open authorization page")}
              </Button>
              {view.deviceCode ? (
                <Button size="sm" variant="ghost" onClick={() => void copyCode()}>
                  {t(copiedFlow === state?.flowId ? "Code copied" : "Copy code")}
                </Button>
              ) : null}
            </div>
            {view.authorizationCode && state?.flowId ? (
              <AuthorizationCodeForm
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
                  : labels.signIn,
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

function AuthorizationCodeForm(props: {
  readonly disabled: boolean;
  readonly onSubmit: (code: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [code, setCode] = useState("");
  return (
    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (props.disabled || !code.trim()) return;
        props.onSubmit(code.trim());
        setCode("");
      }}
    >
      <label htmlFor={id} className="text-sm">
        {t("Authorization code")}
      </label>
      <Input
        id={id}
        type="password"
        autoComplete="off"
        spellCheck={false}
        maxLength={4096}
        value={code}
        disabled={props.disabled}
        onChange={(event) => setCode(event.target.value)}
      />
      <div>
        <Button type="submit" size="sm" disabled={props.disabled || !code.trim()}>
          {t("Submit authorization code")}
        </Button>
      </div>
    </form>
  );
}
