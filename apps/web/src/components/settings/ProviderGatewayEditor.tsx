import {
  addGatewayHeader,
  buildGatewayInstance,
  createGatewayDraft,
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
import { useId, useRef, useState } from "react";
import { useT } from "../../i18n";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function ProviderGatewayEditor({
  environmentId,
  instanceId,
  instance,
  instances,
  readOnly,
}: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  instance: ProviderInstanceConfig;
  instances: ProviderInstanceConfigMap;
  readOnly: boolean;
}) {
  const t = useT();
  const id = useId();
  const [draft, updateDraft] = useState(() => createGatewayDraft(instance));
  const [expanded, setExpanded] = useState(Boolean(instance.gateway));
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<ProviderGatewayProbeResult | null>(null);
  const setDraft: typeof updateDraft = (next) => {
    setResult(null);
    updateDraft(next);
  };
  const probe = useAtomCommand(serverEnvironment.providerGatewayProbe, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const disabled = readOnly || busy;
  const field = (key: "baseUrl" | "model", label: string, placeholder?: string) => (
    <label className="grid gap-1 text-xs" htmlFor={`${id}-${key}`}>
      {t(label)}
      <Input
        id={`${id}-${key}`}
        value={draft.gateway[key]}
        placeholder={placeholder}
        spellCheck={false}
        disabled={disabled}
        onChange={(event) => {
          setResult(null);
          setDraft({ ...draft, gateway: { ...draft.gateway, [key]: event.target.value } });
        }}
      />
    </label>
  );
  async function run(action: "models" | "test" | "save" | "remove") {
    if (pending.current || readOnly) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
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
        setNotice(
          action === "remove"
            ? "Gateway removed; native instance settings restored."
            : "Gateway saved.",
        );
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
  if (instance.driver !== "claudeAgent" && instance.driver !== "codex")
    return (
      <p className="px-4 py-3 text-xs text-muted-foreground">
        {t("Custom gateways currently support Claude Code and Codex.")}
      </p>
    );
  if (!expanded)
    return (
      <div className="px-3 py-3 sm:px-4">
        <Button variant="outline" size="sm" onClick={() => setExpanded(true)}>
          {t("Configure custom gateway")}
        </Button>
      </div>
    );
  return (
    <div className="grid gap-3 px-3 py-3 sm:px-4">
      <p className="text-xs text-muted-foreground">{t(gatewayLabels.help)}</p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={draft.gateway.enabled}
          disabled={disabled}
          onChange={(event) =>
            setDraft({ ...draft, gateway: { ...draft.gateway, enabled: event.target.checked } })
          }
        />
        {t("Enable custom gateway")}
      </label>
      <p className="text-xs">
        {t("Native protocol")}:{" "}
        {draft.gateway.protocol === "anthropic" ? "Anthropic Messages" : "OpenAI Responses"}
      </p>
      {instance.driver === "claudeAgent" ? (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            setDraft({
              ...draft,
              gateway: { ...draft.gateway, baseUrl: "https://openrouter.ai/api", auth: "bearer" },
            })
          }
        >
          {t("Use OpenRouter address")}
        </Button>
      ) : null}
      {field("baseUrl", "Gateway base URL", "https://gateway.example/api")}
      <p className="text-xs text-muted-foreground">{t(gatewayLabels.baseHelp)}</p>
      <Select
        value={draft.gateway.auth}
        disabled={disabled}
        onValueChange={(value) => {
          if (value === "bearer" || value === "api-key")
            setDraft({ ...draft, gateway: { ...draft.gateway, auth: value } });
        }}
      >
        <SelectTrigger aria-label={t("Gateway authentication")}>
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value="bearer">Bearer token</SelectItem>
          <SelectItem value="api-key">x-api-key</SelectItem>
        </SelectPopup>
      </Select>
      <label className="grid gap-1 text-xs" htmlFor={`${id}-key`}>
        {t("Gateway API key")}
        <Input
          id={`${id}-key`}
          type="password"
          autoComplete="new-password"
          disabled={disabled}
          value={draft.key.value}
          placeholder={draft.key.valueRedacted ? t("Saved; leave unchanged to keep") : ""}
          onChange={(event) =>
            setDraft({
              ...draft,
              key: { ...draft.key, value: event.target.value, valueRedacted: false },
            })
          }
        />
      </label>
      {field("model", "Default model ID")}
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run("models")}>
        {t("Load gateway models")}
      </Button>
      {result?.models.length ? (
        <Select
          value={draft.gateway.model}
          disabled={disabled}
          onValueChange={(model) => {
            if (model) setDraft({ ...draft, gateway: { ...draft.gateway, model } });
          }}
        >
          <SelectTrigger aria-label={t("Choose gateway model")}>
            <SelectValue placeholder={t("Choose gateway model")} />
          </SelectTrigger>
          <SelectPopup>
            {result.models.map((model) => (
              <SelectItem key={model} value={model}>
                {model}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      <label className="grid gap-1 text-xs" htmlFor={`${id}-models`}>
        {t("Additional model IDs")}
        <Textarea
          id={`${id}-models`}
          value={draft.modelText}
          disabled={disabled}
          onChange={(event) => setDraft({ ...draft, modelText: event.target.value })}
          rows={4}
        />
      </label>
      <p className="text-xs text-muted-foreground">{t(gatewayLabels.modelsHelp)}</p>
      {instance.driver === "claudeAgent" ? (
        <details>
          <summary className="cursor-pointer text-sm">{t("Claude model mapping")}</summary>
          <div className="mt-3 grid gap-2">
            {(["opus", "sonnet", "haiku", "subagent"] as const).map((role) => (
              <label key={role} className="grid gap-1 text-xs" htmlFor={`${id}-${role}`}>
                {role}
                <Input
                  id={`${id}-${role}`}
                  disabled={disabled}
                  value={draft.gateway.roles[role] ?? ""}
                  placeholder={draft.gateway.model}
                  onChange={(event) => {
                    const roles = { ...draft.gateway.roles };
                    if (event.target.value.trim()) roles[role] = event.target.value.trim();
                    else delete roles[role];
                    setDraft({ ...draft, gateway: { ...draft.gateway, roles } });
                  }}
                />
              </label>
            ))}
          </div>
        </details>
      ) : null}
      <details>
        <summary className="cursor-pointer text-sm">{t("Custom request headers")}</summary>
        <div className="mt-3 grid gap-2">
          {draft.headers.map((header, index) => (
            <div key={header.credential.name} className="grid gap-2">
              <Input
                aria-label={t("Header name")}
                placeholder="X-Custom-Header"
                value={header.name}
                disabled={disabled}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    headers: draft.headers.map((item, i) =>
                      i === index ? { ...item, name: event.target.value } : item,
                    ),
                  })
                }
              />
              <Input
                aria-label={t("Header value")}
                type="password"
                autoComplete="new-password"
                value={header.credential.value}
                placeholder={
                  header.credential.valueRedacted
                    ? t("Saved; leave unchanged to keep")
                    : t("Header value")
                }
                disabled={disabled}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    headers: draft.headers.map((item, i) =>
                      i === index
                        ? {
                            ...item,
                            credential: {
                              ...item.credential,
                              value: event.target.value,
                              valueRedacted: false,
                            },
                          }
                        : item,
                    ),
                  })
                }
              />
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  setDraft({ ...draft, headers: draft.headers.filter((_, i) => i !== index) })
                }
              >
                {t("Remove header")}
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || draft.headers.length >= 20}
            onClick={() => setDraft(addGatewayHeader(draft))}
          >
            {t("Add header")}
          </Button>
        </div>
      </details>
      <p className="text-xs text-muted-foreground">{t(gatewayLabels.testHelp)}</p>
      <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run("test")}>
        {busy ? t("Working…") : t("Test connection")}
      </Button>
      {result ? (
        <ul className="text-xs" aria-live="polite">
          {result.checks.map((check) => (
            <li key={check.name}>
              {check.ok ? "✓" : "✗"} {t(check.name)}: {t(check.detail)}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted-foreground">{t(gatewayLabels.saveHelp)}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={disabled} onClick={() => void run("save")}>
          {t("Save gateway")}
        </Button>
        {instance.gateway ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => void run("remove")}
          >
            {t("Remove gateway")}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {t(error)}
        </p>
      ) : null}
      {notice ? (
        <p className="text-xs" role="status">
          {t(notice)}
        </p>
      ) : null}
    </div>
  );
}
