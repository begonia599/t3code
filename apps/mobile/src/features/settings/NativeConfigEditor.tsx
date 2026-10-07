import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  editNativeConfigField,
  nativeConfigFields,
  nativeConfigValue,
  parseNativeConfig,
  type NativeConfigField,
} from "@t3tools/shared/nativeConfig";
import { useState } from "react";
import { Alert, Modal, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { useProjects } from "../../state/entities";
import { useMobileT } from "../../i18n";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { useNativeConfigEditor } from "./useNativeConfigEditor";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}

export function NativeConfigEditorButton(props: Props) {
  const t = useMobileT();
  const [open, setOpen] = useState(false);
  const [cwd, setCwd] = useState("");
  return (
    <>
      <SettingsActionRow
        icon="doc.text"
        label={t("Native configuration")}
        onPress={() => setOpen(true)}
      />
      {open ? (
        <NativeConfigEditor
          key={cwd}
          {...props}
          cwd={cwd}
          setCwd={setCwd}
          close={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function NativeConfigEditor({
  environmentId,
  instanceId,
  readOnly,
  cwd,
  setCwd,
  close,
}: Props & {
  readonly cwd: string;
  readonly setCwd: (cwd: string) => void;
  readonly close: () => void;
}) {
  const t = useMobileT();
  const insets = useSafeAreaInsets();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const { editor, state } = useNativeConfigEditor(environmentId, {
    instanceId,
    ...(cwd ? { cwd } : {}),
  });
  const [query, setQuery] = useState("");
  const [showFiles, setShowFiles] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [chooseScope, setChooseScope] = useState(false);
  const [fileLimit, setFileLimit] = useState(50);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const { catalog, document, busy } = state;
  const dirty = editor.dirty();
  const disabled = readOnly || busy || !document?.file.writable;
  const requestClose = () => {
    if (busy) return;
    if (!dirty) {
      close();
      return;
    }
    Alert.alert(t("Discard unsaved changes and close?"), undefined, [
      { text: t("Keep editing"), style: "cancel" },
      { text: t("Discard and close"), style: "destructive", onPress: close },
    ]);
  };
  const content =
    state.draft || (!document?.file.exists && document?.file.format === "json" ? "{}\n" : "");
  const format =
    document?.file.kind === "settings" && document.file.format !== "markdown"
      ? document.file.format
      : null;
  let parsed: Record<string, unknown> | null = null;
  if (format && !showRaw) {
    try {
      parsed = parseNativeConfig(content, format);
    } catch {
      /* Raw repair stays available. */
    }
  }
  const apply = (field: NativeConfigField, value: string) => {
    if (!format) return;
    try {
      editor.edit(editNativeConfigField(content, format, field, value));
      setFieldError(null);
    } catch (cause) {
      setFieldError(cause instanceof Error ? cause.message : "The configuration operation failed.");
    }
  };
  return (
    <Modal visible animationType="slide" onRequestClose={requestClose}>
      <View
        className="flex-1 bg-background"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerClassName="gap-4 p-4">
          <Text className="text-xl font-t3-medium text-foreground">
            {t("Native configuration")} · {instanceId}
          </Text>
          <MaterialButton label={t("Close")} disabled={busy} onPress={requestClose} />
          <Text className="text-sm text-foreground-muted">
            {t(
              "These are native files, not an effective-settings report. Project trust, parent instructions, policies, environment variables and T3 session options can change what the agent loads.",
            )}
          </Text>
          <Text selectable className="text-xs text-foreground">
            {catalog?.homePath}
          </Text>
          {catalog?.environmentOverrides.length || catalog?.hasLaunchOverrides ? (
            <Text className="text-xs text-foreground-muted">
              {t("Runtime overrides are present")} · {catalog.environmentOverrides.join(", ")}
            </Text>
          ) : null}
          <MaterialButton
            label={`${t("Configuration scope")}: ${cwd || t("User files")}`}
            disabled={busy || dirty}
            onPress={() => setChooseScope(!chooseScope)}
          />
          {chooseScope ? (
            <View className="gap-2">
              <MaterialButton
                label={t("User files")}
                disabled={busy || dirty}
                onPress={() => {
                  setChooseScope(false);
                  setCwd("");
                }}
              />
              {projects.map((project) => (
                <MaterialButton
                  key={project.id}
                  label={`${project.title} · ${project.workspaceRoot}`}
                  disabled={busy || dirty}
                  onPress={() => {
                    setChooseScope(false);
                    setCwd(project.workspaceRoot);
                  }}
                />
              ))}
            </View>
          ) : null}
          <MaterialButton
            label={t("Native files")}
            disabled={busy || dirty}
            onPress={() => setShowFiles(!showFiles)}
          />
          {showFiles ? (
            <>
              <TextInput
                accessibilityLabel={t("Search native files")}
                placeholder={t("Search native files")}
                value={query}
                onChangeText={(value) => {
                  setQuery(value);
                  setFileLimit(50);
                }}
                className="rounded-lg border border-border p-3 text-foreground"
              />
              <MaterialButton
                label={t("Refresh list")}
                disabled={busy}
                onPress={() => void editor.load()}
              />
              {catalog?.truncated ? (
                <Text className="text-foreground-muted">
                  {t("Some sources could not be listed or the discovery limit was reached.")}
                </Text>
              ) : null}
              {catalog?.files
                .filter((file) =>
                  `${file.path} ${t(file.kind)} ${t(file.scope)}`
                    .toLocaleLowerCase()
                    .includes(query.toLocaleLowerCase()),
                )
                .slice(0, fileLimit)
                .map((file) => (
                  <View key={file.path} className="gap-1">
                    <MaterialButton
                      fullWidth
                      label={`${file.path}\n${t(file.scope)} · ${t(file.kind)} · ${t(file.exists ? (file.writable ? "Editable" : "Read-only") : "Not created")}`}
                      disabled={busy || dirty}
                      onPress={() => {
                        void editor.open(file.path).then(() => {
                          if (editor.getSnapshot().document?.file.path === file.path) {
                            setShowFiles(false);
                            setFieldError(null);
                          }
                        });
                      }}
                    />
                    {file.problem ? (
                      <Text className="text-danger-foreground">{t(file.problem)}</Text>
                    ) : null}
                  </View>
                ))}
              {(catalog?.files.filter((file) =>
                `${file.path} ${t(file.kind)} ${t(file.scope)}`
                  .toLocaleLowerCase()
                  .includes(query.toLocaleLowerCase()),
              ).length ?? 0) > fileLimit ? (
                <MaterialButton
                  label={t("Show more")}
                  onPress={() => setFileLimit(fileLimit + 50)}
                />
              ) : null}
            </>
          ) : null}
          <MaterialButton
            label={t("Refresh agent skills")}
            disabled={busy || readOnly}
            onPress={() => void editor.refreshSkills()}
          />
          {document ? (
            <>
              <Text selectable className="text-xs text-foreground">
                {document.resolvedPath}
              </Text>
              <MaterialButton
                label={t("Reload saved file")}
                disabled={busy}
                onPress={() => void editor.reload()}
              />
              {format ? (
                <MaterialButton
                  label={t(showRaw ? "Graphical settings" : "Raw editor")}
                  onPress={() => setShowRaw(!showRaw)}
                />
              ) : null}
              {format && !showRaw ? (
                <>
                  <Text className="text-xs text-foreground-muted">
                    {t(
                      "Verified fields: Codex 0.160.1 / Claude Code 2.1.291. Other fields remain available in the raw editor. Unset means inherit; no defaults are written automatically.",
                    )}
                  </Text>
                  {!parsed ? (
                    <Text className="text-danger-foreground">
                      {t("The draft has invalid syntax. Use the raw editor to repair it.")}
                    </Text>
                  ) : (
                    nativeConfigFields[format].map((field) => (
                      <NativeField
                        key={field.path.join(".")}
                        field={field}
                        value={nativeConfigValue(parsed!, field.path)}
                        disabled={disabled}
                        apply={(value) => apply(field, value)}
                      />
                    ))
                  )}
                </>
              ) : (
                <TextInput
                  accessibilityLabel={t("Native file contents")}
                  multiline
                  scrollEnabled={false}
                  autoCorrect={false}
                  autoCapitalize="none"
                  editable={!disabled}
                  value={state.draft}
                  onChangeText={editor.edit}
                  className="min-h-72 rounded-lg border border-border p-3 font-mono text-sm text-foreground"
                  style={{ textAlignVertical: "top" }}
                />
              )}
              {fieldError ? (
                <Text accessibilityRole="alert" className="text-danger-foreground">
                  {t(fieldError)}
                </Text>
              ) : null}
              <View className="flex-row flex-wrap gap-2">
                <MaterialButton
                  label={t("Save")}
                  tone="primary"
                  disabled={disabled || !dirty}
                  onPress={() => void editor.save()}
                />
                <MaterialButton
                  label={t("Preview changes")}
                  disabled={disabled || !dirty}
                  onPress={() => void editor.preview()}
                />
                <MaterialButton
                  label={t("Discard draft")}
                  disabled={busy || !dirty}
                  onPress={editor.discard}
                />
                <MaterialButton
                  label={t("Undo save")}
                  disabled={disabled || dirty || !state.undoToken}
                  onPress={() => void editor.undo()}
                />
              </View>
              {state.diff !== null ? (
                <Text selectable className="font-mono text-xs text-foreground">
                  {state.diff}
                </Text>
              ) : null}
              <MaterialButton
                label={t("Saved file contents")}
                onPress={() => setShowSaved(!showSaved)}
              />
              {showSaved ? (
                <Text selectable className="font-mono text-xs text-foreground">
                  {document.content || t("Empty file")}
                </Text>
              ) : null}
            </>
          ) : (
            <Text className="text-foreground-muted">
              {t(busy ? "Loading native files…" : "Select a native file to view or edit.")}
            </Text>
          )}
          {state.error ? (
            <Text accessibilityRole="alert" className="text-danger-foreground">
              {t(state.error)}
            </Text>
          ) : null}
          {state.notice ? <Text className="text-foreground">{t(state.notice)}</Text> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function NativeField({
  field,
  value,
  disabled,
  apply,
}: {
  readonly field: NativeConfigField;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly apply: (value: string) => void;
}) {
  const t = useMobileT();
  const [choosing, setChoosing] = useState(false);
  const text = value === undefined ? "" : String(value);
  // Keying the input by the saved draft value refreshes it after raw edits/undo.
  return (
    <View className="gap-2 border-b border-border pb-3">
      <Text className="text-foreground">{t(field.label)}</Text>
      <Text className="font-mono text-xs text-foreground-muted">{field.path.join(".")}</Text>
      <Text className="text-xs text-foreground-muted">{t(field.description)}</Text>
      {field.options ? (
        <>
          <MaterialButton
            label={text || t("Inherit / native default")}
            disabled={disabled}
            onPress={() => setChoosing(!choosing)}
          />
          {choosing
            ? field.options.map((option) => (
                <MaterialButton
                  key={option}
                  label={option}
                  disabled={disabled}
                  onPress={() => {
                    apply(option);
                    setChoosing(false);
                  }}
                />
              ))
            : null}
        </>
      ) : (
        <NativeNumberInput
          key={text}
          label={t(field.label)}
          initial={text}
          disabled={disabled}
          apply={apply}
        />
      )}
      {field.min !== undefined ? (
        <Text className="text-xs text-foreground-muted">
          {t("Editor range")}: {field.min}–{field.max}
        </Text>
      ) : null}
      <MaterialButton
        label={t("Remove override")}
        disabled={disabled || value === undefined}
        tone="text"
        onPress={() => apply("")}
      />
    </View>
  );
}

function NativeNumberInput({
  label,
  initial,
  disabled,
  apply,
}: {
  readonly label: string;
  readonly initial: string;
  readonly disabled: boolean;
  readonly apply: (value: string) => void;
}) {
  const t = useMobileT();
  const [value, setValue] = useState(initial);
  return (
    <View className="gap-2">
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={setValue}
        editable={!disabled}
        keyboardType="number-pad"
        placeholder={t("Inherit / native default")}
        className="rounded-lg border border-border p-3 text-foreground"
      />
      <MaterialButton
        label={t("Set in draft")}
        disabled={disabled || initial === value}
        onPress={() => apply(value)}
      />
    </View>
  );
}
