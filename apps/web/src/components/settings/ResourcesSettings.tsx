import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  CredentialWriteInput,
  HostedMcpConfig,
  GitHubToolBinding,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type CredentialMetadata,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { resources } from "../../state/resources";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useResourceMutation } from "../../hooks/useResourceMutation";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogPanel,
} from "../ui/dialog";
import { CredentialInputRequestPanel } from "../chat/ComposerPendingCredentialInputPanel";
import { ComposerBanner } from "../chat/ComposerBanner";
import { SettingsSection } from "./settingsLayout";
import { ApplicationsSettings } from "./ApplicationsSettings";

const isCredentialWrite = Schema.is(CredentialWriteInput);
const decodeMcp = Schema.decodeUnknownOption(Schema.fromJsonString(HostedMcpConfig));
const decodeTool = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubToolBinding));

function CredentialForm(props: {
  environmentId: EnvironmentId;
  credential?: CredentialMetadata;
  onSaved: () => void;
}) {
  const t = useT();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const [name, setName] = useState(props.credential?.name ?? "");
  const [description, setDescription] = useState(props.credential?.description ?? "");
  const [value, setValue] = useState("");
  const [valueType, setValueType] = useState<"token" | "text">(
    props.credential?.valueType ?? "token",
  );
  const [usage, setUsage] = useState<"shell-and-bindings" | "bindings-only">(
    props.credential?.usage ?? "shell-and-bindings",
  );
  const [allowed, setAllowed] = useState<ReadonlyArray<ProviderInstanceId>>(
    props.credential?.allowedInstances ?? [],
  );
  const { mutate, busy, error } = useResourceMutation(props.environmentId);
  const [invalid, setInvalid] = useState(false);
  const candidates = new Map<ProviderInstanceId, string>(
    (["claudeAgent", "codex", "grok"] as const).map((driver) => [
      defaultInstanceIdForDriver(ProviderDriverKind.make(driver)),
      driver,
    ]),
  );
  for (const [id, instance] of Object.entries(settings?.providerInstances ?? {}))
    candidates.set(ProviderInstanceId.make(id), instance.displayName ?? id);
  for (const id of allowed) if (!candidates.has(id)) candidates.set(id, id);
  async function submit() {
    const input = {
      name,
      description,
      valueType,
      usage,
      ...(value ? { value: Redacted.make(value) } : {}),
      allowedInstances: allowed,
    };
    if (!isCredentialWrite(input) || (!value && !props.credential)) {
      setInvalid(true);
      return;
    }
    if (await mutate({ type: "write", payload: input })) {
      setValue("");
      props.onSaved();
    }
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3"
    >
      <label>
        {t("Variable name")}
        <Input
          value={name}
          disabled={busy || !!props.credential}
          onChange={(event) => setName(event.target.value)}
          autoComplete="off"
        />
      </label>
      <label>
        {t("Description")}
        <Input
          value={description}
          disabled={busy}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label>
        {t("Value type")}
        <select
          value={valueType}
          disabled={busy}
          onChange={(event) => setValueType(event.target.value === "text" ? "text" : "token")}
        >
          <option value="token">{t("Token")}</option>
          <option value="text">{t("Text")}</option>
        </select>
      </label>
      <label>
        {t("Private value")}
        {valueType === "text" ? (
          <Textarea
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            aria-label={t("Private value")}
            rows={5}
            placeholder={props.credential ? t("Leave blank to keep the existing value.") : ""}
          />
        ) : (
          <Input
            type="password"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="new-password"
            placeholder={props.credential ? t("Leave blank to keep the existing value.") : ""}
          />
        )}
      </label>
      <p className="text-xs text-muted-foreground">
        {t("This value is saved directly to the vault and is not sent as a chat message.")}
      </p>
      <label>
        {t("Credential use")}
        <select
          value={usage}
          disabled={busy}
          onChange={(event) =>
            setUsage(
              event.target.value === "bindings-only" ? "bindings-only" : "shell-and-bindings",
            )
          }
        >
          <option value="shell-and-bindings">{t("Shell and tool bindings")}</option>
          <option value="bindings-only">{t("Tool bindings only")}</option>
        </select>
      </label>
      <fieldset disabled={busy} className="flex flex-col gap-2">
        <legend>{t("Allowed provider instances")}</legend>
        {[...candidates].map(([id, label]) => (
          <label key={id} className="flex items-center gap-2">
            <Checkbox
              checked={allowed.includes(id)}
              onCheckedChange={(checked) =>
                setAllowed(checked ? [...allowed, id] : allowed.filter((entry) => entry !== id))
              }
            />
            {label}
          </label>
        ))}
      </fieldset>
      {invalid ? <p role="alert">{t("Enter a valid variable name and a private value.")}</p> : null}
      {error ? <p role="alert">{t(error)}</p> : null}
      <Button type="submit" disabled={busy}>
        {t("Save")}
      </Button>
    </form>
  );
}
function ResourceContent(props: { environmentId: EnvironmentId }) {
  const t = useT();
  const state = useAtomValue(resources.snapshot({ environmentId: props.environmentId, input: {} }));
  const snapshot = Option.getOrNull(AsyncResult.value(state));
  const { mutate, busy, error } = useResourceMutation(props.environmentId);
  const [editor, setEditor] = useState<CredentialMetadata | "new" | null>(null);
  const [mcpDraft, setMcpDraft] = useState<string | null>(null);
  const [mcpInvalid, setMcpInvalid] = useState(false);
  const [toolDraft, setToolDraft] = useState<string | null>(null);
  const [toolInvalid, setToolInvalid] = useState(false);
  const pending = snapshot?.vault.requests ?? [];
  const [requestId, setRequestId] = useState<string | null>(null);
  const activeRequest = pending.find((request) => request.id === requestId);
  if (!snapshot)
    return (
      <p>
        {t(
          AsyncResult.isFailure(state)
            ? "Could not load resources. Administrator access is required."
            : "Loading resources…",
        )}
      </p>
    );
  async function saveMcp() {
    if (!mcpDraft) return;
    const decoded = decodeMcp(mcpDraft);
    if (Option.isNone(decoded)) {
      setMcpInvalid(true);
      return;
    }
    if (await mutate({ type: "writeMcp", payload: decoded.value })) {
      setMcpDraft(null);
      setMcpInvalid(false);
    }
  }
  async function saveTool() {
    const decoded = decodeTool(toolDraft);
    if (Option.isNone(decoded)) {
      setToolInvalid(true);
      return;
    }
    if (await mutate({ type: "writeTool", payload: decoded.value })) {
      setToolDraft(null);
      setToolInvalid(false);
    }
  }
  const newMcp = () =>
    setMcpDraft(
      JSON.stringify(
        {
          id: "my-service",
          label: "My MCP",
          enabled: true,
          allowedInstances: ["claudeAgent", "codex", "grok"],
          transport: {
            type: "stdio",
            command: "/usr/bin/node",
            args: ["/path/to/server.js"],
            environment: { API_KEY: { credential: "API_KEY" } },
          },
        },
        null,
        2,
      ),
    );
  return (
    <>
      {pending.length ? (
        <div className="flex flex-wrap items-center gap-2 p-3">
          <span>{t("Private input requested")}</span>
          {pending.map((request) => (
            <Button
              key={request.id}
              size="sm"
              variant="outline"
              onClick={() => setRequestId(request.id)}
            >
              {request.name}
            </Button>
          ))}
        </div>
      ) : null}
      <>
        <SettingsSection title={t("Credential vault")}>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "Manage application credentials here. Agents can list metadata and request use without viewing values.",
              )}
            </p>
            <Button size="sm" variant="outline" onClick={() => setEditor("new")}>
              {t("Add credential")}
            </Button>
            {snapshot.vault.credentials.map((credential) => (
              <div key={credential.name} className="flex flex-wrap items-center gap-2">
                <div className="mr-auto">
                  <strong>{credential.name}</strong>
                  <p className="text-xs text-muted-foreground">
                    {credential.valueType} · {credential.length} ·{" "}
                    {credential.allowedInstances.join(", ") || t("No instances allowed")}
                  </p>
                </div>
                <Button size="sm" variant="ghost" onClick={() => setEditor(credential)}>
                  {t("Edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      type: "action",
                      payload: { action: "delete", name: credential.name },
                    })
                  }
                >
                  {t("Delete")}
                </Button>
              </div>
            ))}
            {snapshot.vault.grants.map((grant) => (
              <div key={grant.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {grant.instanceId} · {grant.names.join(", ")} · {grant.purpose}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate({ type: "action", payload: { action: "revoke", id: grant.id } })
                  }
                >
                  {t("Revoke")}
                </Button>
              </div>
            ))}
          </div>
        </SettingsSection>
        <SettingsSection title={t("Hosted MCP services")}>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "T3 runs local MCP services and connects remote services. Bind credentials by name; reconnect the agent after adding a service.",
              )}
            </p>
            <Button size="sm" variant="outline" onClick={newMcp}>
              {t("Add MCP service")}
            </Button>
            {snapshot.mcp.map(({ config, status, connections }) => (
              <div key={config.id} className="flex flex-wrap items-center gap-2">
                <span className="mr-auto">
                  {config.label} · {t(status)} · {connections}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setMcpDraft(JSON.stringify(config, null, 2))}
                >
                  {t("Edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      type: "actionMcp",
                      payload: { id: config.id, action: config.enabled ? "stop" : "restart" },
                    })
                  }
                >
                  {t(config.enabled ? "Stop" : "Start")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      type: "actionMcp",
                      payload: { id: config.id, action: "restart" },
                    })
                  }
                >
                  {t("Restart")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      type: "actionMcp",
                      payload: { id: config.id, action: "delete" },
                    })
                  }
                >
                  {t("Delete")}
                </Button>
              </div>
            ))}
          </div>
        </SettingsSection>
        <SettingsSection title={t("Native gh tool bindings")}>
          <div className="flex flex-col gap-3 p-4">
            <p className="text-sm text-muted-foreground">
              {t(
                "Managed instances automatically use T3's current GitHub CLI login. You can revoke an instance or override its authorization. GitHub App bindings can limit repository access.",
              )}
            </p>
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setToolDraft(
                    JSON.stringify(
                      {
                        instanceId: "codex",
                        enabled: true,
                        host: "github.com",
                        account: "your-account",
                        repositories: [],
                        source: { type: "host-login" },
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                {t("Add gh binding")}
              </Button>
            </div>
            {(snapshot.tools ?? []).map((state) => (
              <div key={state.binding.instanceId} className="flex flex-wrap items-center gap-2">
                <span className="mr-auto">
                  {state.binding.instanceId} · {state.binding.account} · {t(state.status)}
                  <p className="text-xs text-muted-foreground">{state.message}</p>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setToolDraft(JSON.stringify(state.binding, null, 2))}
                >
                  {t("Edit")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      type: "actionTool",
                      payload: { instanceId: state.binding.instanceId, action: "check" },
                    })
                  }
                >
                  {t("Verify binding")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate(
                      state.binding.enabled
                        ? {
                            type: "actionTool",
                            payload: { instanceId: state.binding.instanceId, action: "delete" },
                          }
                        : {
                            type: "writeTool",
                            payload: { ...state.binding, enabled: true },
                          },
                    )
                  }
                >
                  {t(state.binding.enabled ? "Revoke" : "Enable")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void mutate({
                      type: "actionTool",
                      payload: { instanceId: state.binding.instanceId, action: "reset" },
                    })
                  }
                >
                  {t("Use T3 GitHub login")}
                </Button>
              </div>
            ))}
          </div>
        </SettingsSection>
        <ApplicationsSettings environmentId={props.environmentId} />
        {error ? <p role="alert">{t(error)}</p> : null}
      </>
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>{t("Credential vault")}</DialogTitle>
          {editor ? (
            <CredentialForm
              key={editor === "new" ? "new" : editor.name}
              environmentId={props.environmentId}
              {...(editor === "new" ? {} : { credential: editor })}
              onSaved={() => setEditor(null)}
            />
          ) : null}
        </DialogPopup>
      </Dialog>
      <Dialog
        open={activeRequest !== undefined}
        onOpenChange={(open) => {
          if (!open) setRequestId(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t("Private input requested")}</DialogTitle>
          </DialogHeader>
          {activeRequest ? (
            <DialogPanel>
              <ComposerBanner.Root placement="floating">
                <CredentialInputRequestPanel
                  key={activeRequest.id}
                  environmentId={props.environmentId}
                  request={activeRequest}
                  onAnswered={() => setRequestId(null)}
                />
              </ComposerBanner.Root>
            </DialogPanel>
          ) : null}
        </DialogPopup>
      </Dialog>
      <Dialog
        open={mcpDraft !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMcpDraft(null);
            setMcpInvalid(false);
          }
        }}
      >
        <DialogPopup>
          <DialogTitle>{t("Hosted MCP services")}</DialogTitle>
          <DialogDescription>
            {t(
              "Use credential references in environment or headers. Never paste secret values into this configuration.",
            )}
          </DialogDescription>
          <Textarea
            value={mcpDraft ?? ""}
            onChange={(event) => setMcpDraft(event.target.value)}
            rows={16}
            spellCheck={false}
            aria-label={t("MCP configuration")}
          />
          {mcpInvalid ? <p role="alert">{t("Invalid MCP configuration.")}</p> : null}
          {error ? <p role="alert">{t(error)}</p> : null}
          <Button disabled={busy} onClick={() => void saveMcp()}>
            {t("Save")}
          </Button>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={toolDraft !== null}
        onOpenChange={(open) => {
          if (!open) {
            setToolDraft(null);
            setToolInvalid(false);
          }
        }}
      >
        <DialogPopup>
          <DialogTitle>{t("Native gh tool bindings")}</DialogTitle>
          <DialogDescription>
            {t(
              "For host-login, enter the account already logged in on T3 and leave repositories empty. GitHub App bindings use a vault private-key reference with Tool bindings only.",
            )}
          </DialogDescription>
          <Textarea
            rows={16}
            value={toolDraft ?? ""}
            onChange={(event) => setToolDraft(event.target.value)}
            spellCheck={false}
            aria-label={t("gh binding configuration")}
          />
          {toolInvalid ? <p role="alert">{t("Invalid gh binding configuration.")}</p> : null}
          {error ? <p role="alert">{t(error)}</p> : null}
          <Button disabled={busy} onClick={() => void saveTool()}>
            {t("Save")}
          </Button>
        </DialogPopup>
      </Dialog>
    </>
  );
}
export function ResourcesSettings(props: { environmentId: EnvironmentId }) {
  const t = useT();
  const { data } = useEnvironmentSessionState(props.environmentId);
  if (!data?.scopes?.includes(AuthAccessWriteScope))
    return <p>{t("Administrator access is required to manage resources.")}</p>;
  return <ResourceContent key={props.environmentId} {...props} />;
}
