import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  CredentialWriteInput,
  HostedMcpConfig,
  GitHubToolBinding,
  ProviderInstanceId,
  type CredentialInputRequest,
  type CredentialMetadata,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { ResourceMutation } from "@t3tools/client-runtime/state/resources";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useMobileT } from "../../i18n";
import { resources } from "../../state/resources";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { sandboxSettingsInstances } from "./provider-execution";
import { ApplicationsSettings } from "./ApplicationsSettings";

const isCredentialWrite = Schema.is(CredentialWriteInput);
const decodeMcp = Schema.decodeUnknownOption(Schema.fromJsonString(HostedMcpConfig));
const decodeTool = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubToolBinding));

function Action(props: { label: string; onPress: () => void; disabled?: boolean }) {
  const t = useMobileT();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="px-2 py-2"
    >
      <Text className={props.disabled ? "text-foreground-muted" : "text-primary"}>
        {t(props.label)}
      </Text>
    </Pressable>
  );
}
function ResourceContent(props: {
  environmentId: EnvironmentId;
  threadId?: ThreadId;
  requestsOnly?: boolean;
}) {
  const t = useMobileT();
  const result = useAtomValue(
    resources.snapshot({ environmentId: props.environmentId, input: {} }),
  );
  const snapshot = Option.getOrNull(AsyncResult.value(result));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const execute = useAtomCommand(resources.mutate, { reportFailure: false, reportDefect: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<CredentialMetadata | CredentialInputRequest | "new" | null>(
    null,
  );
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [value, setValue] = useState("");
  const [valueType, setValueType] = useState<"token" | "text">("token");
  const [allowed, setAllowed] = useState<ReadonlyArray<ProviderInstanceId>>([]);
  const [mcpDraft, setMcpDraft] = useState<string | null>(null);
  const [toolDraft, setToolDraft] = useState<string | null>(null);
  const [usage, setUsage] = useState<"shell-and-bindings" | "bindings-only">("shell-and-bindings");
  const mutate = async (input: ResourceMutation) => {
    setBusy(true);
    setError("");
    try {
      const response = await execute({ environmentId: props.environmentId, input });
      if (AsyncResult.isFailure(response)) throw squashAtomCommandFailure(response);
      return true;
    } catch {
      setError("Could not save resources. Check your connection and administrator access.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  function edit(credential: CredentialMetadata | CredentialInputRequest | "new") {
    setEditor(credential);
    setValue("");
    setError("");
    setName(credential === "new" ? "" : credential.name);
    setDescription(credential === "new" ? "" : credential.description);
    setValueType(credential === "new" ? "token" : credential.valueType);
    setUsage(
      credential !== "new" && "usage" in credential
        ? (credential.usage ?? "shell-and-bindings")
        : "shell-and-bindings",
    );
    setAllowed(
      credential === "new"
        ? []
        : "instanceId" in credential
          ? [credential.instanceId]
          : credential.allowedInstances,
    );
  }
  const closeEditor = () => {
    setValue("");
    setEditor(null);
    setError("");
  };
  const request = editor && editor !== "new" && "instanceId" in editor ? editor : null;
  async function saveCredential() {
    const payload = {
      name,
      description,
      valueType,
      usage,
      allowedInstances: allowed,
      ...(value ? { value: Redacted.make(value) } : {}),
      ...(request ? { requestId: request.id } : {}),
    };
    if (!isCredentialWrite(payload) || (!value && (editor === "new" || !!request))) {
      setError("Enter a valid variable name and a private value.");
      return;
    }
    if (await mutate({ type: "write", payload })) closeEditor();
  }
  async function saveMcp() {
    const decoded = decodeMcp(mcpDraft);
    if (Option.isNone(decoded)) {
      setError("Invalid MCP configuration.");
      return;
    }
    if (await mutate({ type: "writeMcp", payload: decoded.value })) setMcpDraft(null);
    setToolDraft(null);
  }
  async function saveTool() {
    const decoded = decodeTool(toolDraft);
    if (Option.isNone(decoded)) {
      setError("Invalid gh binding configuration.");
      return;
    }
    if (await mutate({ type: "writeTool", payload: decoded.value })) setToolDraft(null);
  }
  if (!snapshot)
    return props.requestsOnly ? null : (
      <Text>
        {t(
          AsyncResult.isFailure(result)
            ? "Could not load resources. Administrator access is required."
            : "Loading resources…",
        )}
      </Text>
    );
  const pending = snapshot.vault.requests.filter(
    (entry) => !props.threadId || entry.threadId === props.threadId,
  );
  const candidates = new Map(
    Object.entries(settings ? sandboxSettingsInstances(settings) : {}).map(([id, instance]) => [
      ProviderInstanceId.make(id),
      instance.displayName ?? id,
    ]),
  );
  for (const id of allowed) if (!candidates.has(id)) candidates.set(id, id);
  return (
    <View className="gap-3">
      {pending.map((entry) => (
        <Action
          key={entry.id}
          label={`${t("Private input requested")}: ${entry.name}`}
          onPress={() => edit(entry)}
        />
      ))}
      {!props.requestsOnly ? (
        <View className="gap-3 px-4 py-3">
          <Text className="text-lg text-foreground">{t("Credential vault")}</Text>
          <Text className="text-sm text-foreground-muted">
            {t(
              "Manage application credentials here. Agents can list metadata and request use without viewing values.",
            )}
          </Text>
          <Action label="Add credential" onPress={() => edit("new")} />
          {snapshot.vault.credentials.map((credential) => (
            <View key={credential.name}>
              <Text>
                {credential.name} · {credential.valueType} · {credential.length}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {credential.allowedInstances.join(", ") || t("No instances allowed")}
              </Text>
              <View className="flex-row">
                <Action label="Edit" onPress={() => edit(credential)} />
                <Action
                  label="Delete"
                  disabled={busy}
                  onPress={() =>
                    void mutate({
                      type: "action",
                      payload: { action: "delete", name: credential.name },
                    })
                  }
                />
              </View>
            </View>
          ))}
          {snapshot.vault.grants.map((grant) => (
            <View key={grant.id}>
              <Text>
                {grant.instanceId} · {grant.names.join(", ")} · {grant.purpose}
              </Text>
              <Action
                label="Revoke"
                disabled={busy}
                onPress={() =>
                  void mutate({ type: "action", payload: { action: "revoke", id: grant.id } })
                }
              />
            </View>
          ))}
          <Text className="text-lg text-foreground">{t("Hosted MCP services")}</Text>
          <Text className="text-sm text-foreground-muted">
            {t(
              "T3 runs local MCP services and connects remote services. Bind credentials by name; reconnect the agent after adding a service.",
            )}
          </Text>
          <Action
            label="Add MCP service"
            onPress={() => {
              setError("");
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
            }}
          />
          {snapshot.mcp.map(({ config, status, connections }) => (
            <View key={config.id}>
              <Text>
                {config.label} · {t(status)} · {connections}
              </Text>
              <View className="flex-row flex-wrap">
                <Action
                  label="Edit"
                  onPress={() => {
                    setError("");
                    setMcpDraft(JSON.stringify(config, null, 2));
                  }}
                />
                <Action
                  label={config.enabled ? "Stop" : "Start"}
                  disabled={busy}
                  onPress={() =>
                    void mutate({
                      type: "actionMcp",
                      payload: { id: config.id, action: config.enabled ? "stop" : "restart" },
                    })
                  }
                />
                <Action
                  label="Restart"
                  disabled={busy}
                  onPress={() =>
                    void mutate({
                      type: "actionMcp",
                      payload: { id: config.id, action: "restart" },
                    })
                  }
                />
                <Action
                  label="Delete"
                  disabled={busy}
                  onPress={() =>
                    void mutate({ type: "actionMcp", payload: { id: config.id, action: "delete" } })
                  }
                />
              </View>
            </View>
          ))}
          <Text className="text-lg text-foreground">{t("Native gh tool bindings")}</Text>
          <Text className="text-foreground-muted">
            {t(
              "Authorize native gh per instance using T3's existing GitHub CLI login. It keeps that login's GitHub permissions. A GitHub App can restrict access to selected repositories.",
            )}
          </Text>
          <Action
            label="Add gh binding"
            onPress={() =>
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
          />
          {(snapshot.tools ?? []).map((state) => (
            <View key={state.binding.instanceId}>
              <Text>
                {state.binding.instanceId} · {state.binding.account} · {t(state.status)}
              </Text>
              <Text className="text-foreground-muted">{state.message}</Text>
              <View className="flex-row">
                <Action
                  label="Edit"
                  onPress={() => setToolDraft(JSON.stringify(state.binding, null, 2))}
                />
                <Action
                  label="Verify binding"
                  disabled={busy}
                  onPress={() =>
                    void mutate({
                      type: "actionTool",
                      payload: { instanceId: state.binding.instanceId, action: "check" },
                    })
                  }
                />
                <Action
                  label="Revoke"
                  disabled={busy}
                  onPress={() =>
                    void mutate({
                      type: "actionTool",
                      payload: { instanceId: state.binding.instanceId, action: "delete" },
                    })
                  }
                />
              </View>
            </View>
          ))}
          <ApplicationsSettings environmentId={props.environmentId} />
        </View>
      ) : null}
      {error && editor === null && mcpDraft === null ? (
        <Text accessibilityRole="alert">{t(error)}</Text>
      ) : null}
      <Modal
        visible={editor !== null || mcpDraft !== null || toolDraft !== null}
        animationType="none"
        onRequestClose={() => {
          closeEditor();
          setMcpDraft(null);
          setToolDraft(null);
        }}
      >
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          className="flex-1 bg-background"
        >
          <View className="gap-4 px-5 py-12">
            <Action
              label="Cancel"
              disabled={busy}
              onPress={() => {
                closeEditor();
                setMcpDraft(null);
                setToolDraft(null);
              }}
            />
            <Text className="text-xl">
              {t(
                toolDraft !== null
                  ? "Native gh tool bindings"
                  : mcpDraft !== null
                    ? "Hosted MCP services"
                    : request
                      ? "Private input requested"
                      : "Credential vault",
              )}
            </Text>
            {toolDraft !== null ? (
              <>
                <Text>
                  {t(
                    "For host-login, enter the account already logged in on T3 and leave repositories empty. GitHub App bindings use a vault private-key reference with Tool bindings only.",
                  )}
                </Text>
                <TextInput
                  accessibilityLabel={t("gh binding configuration")}
                  multiline
                  value={toolDraft}
                  onChangeText={setToolDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy}
                  className="min-h-64 rounded-lg border border-border p-3 text-foreground"
                />
                <Action label="Save" disabled={busy} onPress={() => void saveTool()} />
              </>
            ) : mcpDraft !== null ? (
              <>
                <Text>
                  {t(
                    "Use credential references in environment or headers. Never paste secret values into this configuration.",
                  )}
                </Text>
                <TextInput
                  accessibilityLabel={t("MCP configuration")}
                  multiline
                  value={mcpDraft}
                  onChangeText={setMcpDraft}
                  autoCorrect={false}
                  autoCapitalize="none"
                  editable={!busy}
                  className="min-h-80 rounded-lg border border-border p-3 text-foreground"
                />
                <Action label="Save" disabled={busy} onPress={() => void saveMcp()} />
              </>
            ) : (
              <>
                {request ? <Text>{request.purpose}</Text> : null}
                <Text>{t("Variable name")}</Text>
                <TextInput
                  accessibilityLabel={t("Variable name")}
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="none"
                  autoCorrect={false}
                  editable={!busy && editor === "new"}
                  className="rounded-lg border border-border p-3 text-foreground"
                />
                <Text>{t("Description")}</Text>
                <TextInput
                  accessibilityLabel={t("Description")}
                  value={description}
                  onChangeText={setDescription}
                  editable={!busy}
                  className="rounded-lg border border-border p-3 text-foreground"
                />
                <Text>
                  {t("Value type")}: {t(valueType === "token" ? "Token" : "Text")}
                </Text>
                <Action
                  label={valueType === "token" ? "Text" : "Token"}
                  disabled={busy}
                  onPress={() => setValueType(valueType === "token" ? "text" : "token")}
                />
                <Text>{t("Private value")}</Text>
                <TextInput
                  accessibilityLabel={t("Private value")}
                  secureTextEntry={valueType === "token"}
                  multiline={valueType === "text"}
                  value={value}
                  onChangeText={setValue}
                  autoCorrect={false}
                  autoCapitalize="none"
                  autoComplete="off"
                  editable={!busy}
                  placeholder={
                    editor && editor !== "new" && !request
                      ? t("Leave blank to keep the existing value.")
                      : ""
                  }
                  className="rounded-lg border border-border p-3 text-foreground"
                />
                <Text className="text-sm text-foreground-muted">
                  {t(
                    "This value is saved directly to the vault and is not sent as a chat message.",
                  )}
                </Text>
                <Text>
                  {t("Credential use")}:{" "}
                  {t(usage === "bindings-only" ? "Tool bindings only" : "Shell and tool bindings")}
                </Text>
                <Action
                  label={
                    usage === "bindings-only" ? "Shell and tool bindings" : "Tool bindings only"
                  }
                  disabled={busy}
                  onPress={() =>
                    setUsage(usage === "bindings-only" ? "shell-and-bindings" : "bindings-only")
                  }
                />
                <Text>{t("Allowed provider instances")}</Text>
                {[...candidates].map(([id, label]) => (
                  <Pressable
                    key={id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: allowed.includes(id) }}
                    disabled={busy || request?.instanceId === id}
                    onPress={() =>
                      setAllowed(
                        allowed.includes(id)
                          ? allowed.filter((entry) => entry !== id)
                          : [...allowed, id],
                      )
                    }
                    className="py-2"
                  >
                    <Text>
                      {allowed.includes(id) ? "☑" : "☐"} {label}
                    </Text>
                  </Pressable>
                ))}
                <Action label="Save" disabled={busy} onPress={() => void saveCredential()} />
                {request ? (
                  <Action
                    label="Dismiss request"
                    disabled={busy}
                    onPress={() => {
                      void mutate({
                        type: "action",
                        payload: { action: "dismiss", id: request.id },
                      }).then((saved) => {
                        if (saved) closeEditor();
                      });
                    }}
                  />
                ) : null}
              </>
            )}
            {error ? <Text accessibilityRole="alert">{t(error)}</Text> : null}
          </View>
        </ScrollView>
      </Modal>
    </View>
  );
}
export function ResourcesSettings(props: {
  environmentId: EnvironmentId;
  threadId?: ThreadId;
  requestsOnly?: boolean;
}) {
  const t = useMobileT();
  const session = useAtomValue(environmentSession.sessionStateValueAtom(props.environmentId));
  if (!session?.scopes?.includes(AuthAccessWriteScope))
    return props.requestsOnly ? null : (
      <Text>{t("Administrator access is required to manage resources.")}</Text>
    );
  return <ResourceContent key={props.environmentId} {...props} />;
}
