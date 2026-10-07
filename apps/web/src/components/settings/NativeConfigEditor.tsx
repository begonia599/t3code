import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  editNativeConfigField,
  nativeConfigFields,
  nativeConfigValue,
  parseNativeConfig,
  type NativeConfigField,
} from "@t3tools/shared/nativeConfig";
import { useEffect, useState } from "react";
import { useBlocker } from "@tanstack/react-router";
import { useProjects } from "../../state/entities";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { useNativeConfigEditor } from "./useNativeConfigEditor";

interface Props {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}

export function NativeConfigEditorButton(props: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const blocker = useBlocker({
    shouldBlockFn: () => open && (dirty || busy),
    enableBeforeUnload: open && (dirty || busy),
    withResolver: true,
  });
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {t("Native configuration")}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && busy) return;
          if (!next && dirty) {
            setConfirmClose(true);
            return;
          }
          setOpen(next);
        }}
      >
        <DialogPopup className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {t("Native configuration")} · {props.instanceId}
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {open ? (
              <NativeConfigEditor
                {...props}
                onStateChange={(isDirty, isBusy) => {
                  setDirty(isDirty);
                  setBusy(isBusy);
                }}
              />
            ) : null}
            {confirmClose || blocker.status === "blocked" ? (
              <div className="mt-4 flex flex-wrap items-center gap-2" role="alert">
                <span>{t("Discard unsaved changes and close?")}</span>
                <Button
                  variant="outline"
                  onClick={() => {
                    setConfirmClose(false);
                    blocker.reset?.();
                  }}
                >
                  {t("Keep editing")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    setConfirmClose(false);
                    setDirty(false);
                    setOpen(false);
                    blocker.proceed?.();
                  }}
                >
                  {t("Discard and close")}
                </Button>
              </div>
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </>
  );
}

function NativeConfigEditor(
  props: Props & { readonly onStateChange: (dirty: boolean, busy: boolean) => void },
) {
  const t = useT();
  const projects = useProjects().filter((project) => project.environmentId === props.environmentId);
  const [cwd, setCwd] = useState("");
  const [locked, setLocked] = useState(false);
  return (
    <div className="space-y-4">
      <label className="block space-y-1">
        <span>{t("Configuration scope")}</span>
        <Select value={cwd} disabled={locked} onValueChange={(value) => setCwd(value ?? "")}>
          <SelectTrigger aria-label={t("Configuration scope")}>
            <SelectValue>
              {cwd
                ? `${projects.find((project) => project.workspaceRoot === cwd)?.title ?? ""} · ${cwd}`
                : t("User files")}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("User files")}</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.workspaceRoot}>
                {project.title} · {project.workspaceRoot}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      <NativeConfigFiles
        key={cwd}
        {...props}
        cwd={cwd}
        onStateChange={(dirty, busy) => {
          setLocked(dirty || busy);
          props.onStateChange(dirty, busy);
        }}
      />
    </div>
  );
}

function NativeConfigFiles({
  environmentId,
  instanceId,
  readOnly,
  cwd,
  onStateChange,
}: Props & {
  readonly cwd: string;
  readonly onStateChange: (dirty: boolean, busy: boolean) => void;
}) {
  const t = useT();
  const { editor, state } = useNativeConfigEditor(environmentId, {
    instanceId,
    ...(cwd ? { cwd } : {}),
  });
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"fields" | "raw">("fields");
  const dirty = editor.dirty();
  const { catalog, document, busy } = state;
  const disabled = readOnly || busy || !document?.file.writable;
  useEffect(() => {
    onStateChange(dirty, busy);
  }, [dirty, busy, onStateChange]);
  const search = query.toLocaleLowerCase();
  const files =
    catalog?.files.filter((file) =>
      `${file.path} ${file.kind} ${t(file.kind)} ${t(file.scope)}`
        .toLocaleLowerCase()
        .includes(search),
    ) ?? [];
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t(
          "These are native files, not an effective-settings report. Project trust, parent instructions, policies, environment variables and T3 session options can change what the agent loads.",
        )}
      </p>
      {catalog ? (
        <p className="break-all text-xs">
          {t("Instance home")}: {catalog.homePath}
        </p>
      ) : null}
      {catalog?.environmentOverrides.length || catalog?.hasLaunchOverrides ? (
        <details className="text-xs">
          <summary>{t("Runtime overrides are present")}</summary>
          <p className="break-all">{catalog.environmentOverrides.join(", ")}</p>
          <p>
            {t(
              "Values are not displayed here. T3 session options and launch arguments may override file settings.",
            )}
          </p>
        </details>
      ) : null}
      {catalog?.truncated ? (
        <p role="status">
          {t("Some sources could not be listed or the discovery limit was reached.")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Input
          aria-label={t("Search native files")}
          placeholder={t("Search native files")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="outline" disabled={busy} onClick={() => void editor.load()}>
          {t("Refresh list")}
        </Button>
        <Button
          variant="outline"
          disabled={busy || readOnly}
          onClick={() => void editor.refreshSkills()}
        >
          {t("Refresh agent skills")}
        </Button>
      </div>
      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div
          className="max-h-56 space-y-1 overflow-auto md:max-h-[32rem]"
          aria-label={t("Native files")}
        >
          {files.map((file) => (
            <button
              key={file.path}
              type="button"
              disabled={busy || dirty}
              onClick={() => void editor.open(file.path)}
              aria-pressed={document?.file.path === file.path}
              className="block w-full rounded-md border border-border p-2 text-left text-xs break-all hover:bg-accent aria-pressed:bg-accent disabled:opacity-60"
            >
              <span className="block">{file.path}</span>
              <span className="text-muted-foreground">
                {t(file.scope)} · {t(file.kind)} ·{" "}
                {t(file.exists ? (file.writable ? "Editable" : "Read-only") : "Not created")}
              </span>
              {file.problem ? (
                <span className="block text-destructive">{t(file.problem)}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="min-w-0 space-y-3">
          {document ? (
            <>
              <p className="break-all text-xs">{document.resolvedPath}</p>
              <div className="flex flex-wrap gap-2">
                {document.file.kind === "settings" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setMode(mode === "raw" ? "fields" : "raw")}
                  >
                    {t(mode === "raw" ? "Graphical settings" : "Raw editor")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void editor.reload()}
                >
                  {t("Reload saved file")}
                </Button>
              </div>
              {mode === "fields" &&
              document.file.kind === "settings" &&
              document.file.format !== "markdown" ? (
                <NativeConfigFields
                  key={document.file.path}
                  content={
                    state.draft ||
                    (!document.file.exists
                      ? document.file.format === "json"
                        ? "{}\n"
                        : ""
                      : state.draft)
                  }
                  format={document.file.format}
                  disabled={disabled}
                  onChange={editor.edit}
                />
              ) : (
                <textarea
                  aria-label={t("Native file contents")}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  value={state.draft}
                  readOnly={disabled}
                  onChange={(event) => editor.edit(event.target.value)}
                  className="min-h-72 w-full rounded-md border border-input bg-background p-3 font-mono text-sm"
                />
              )}
              <div className="flex flex-wrap gap-2">
                <Button disabled={disabled || !dirty} onClick={() => void editor.save()}>
                  {t(busy ? "Working…" : "Save")}
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled || !dirty}
                  onClick={() => void editor.preview()}
                >
                  {t("Preview changes")}
                </Button>
                <Button
                  variant="outline"
                  disabled={busy || !dirty}
                  onClick={() => editor.discard()}
                >
                  {t("Discard draft")}
                </Button>
                <Button
                  variant="outline"
                  disabled={disabled || dirty || !state.undoToken}
                  onClick={() => void editor.undo()}
                >
                  {t("Undo save")}
                </Button>
              </div>
              {state.diff !== null ? (
                <pre
                  className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border p-2 text-xs"
                  aria-label={t("Changes")}
                >
                  {state.diff}
                </pre>
              ) : null}
              <details className="text-xs">
                <summary>{t("Saved file contents")}</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap">
                  {document.content || t("Empty file")}
                </pre>
              </details>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t(busy ? "Loading native files…" : "Select a native file to view or edit.")}
            </p>
          )}
        </div>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(state.error)}
        </p>
      ) : null}
      {state.notice ? (
        <p role="status" className="text-sm">
          {t(state.notice)}
        </p>
      ) : null}
    </div>
  );
}

function NativeConfigFields({
  content,
  format,
  disabled,
  onChange,
}: {
  readonly content: string;
  readonly format: "toml" | "json";
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  let parsed: Record<string, unknown>;
  try {
    parsed = parseNativeConfig(content, format);
  } catch {
    return (
      <p role="alert">{t("The draft has invalid syntax. Use the raw editor to repair it.")}</p>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        {t(
          "Verified fields: Codex 0.160.1 / Claude Code 2.1.291. Other fields remain available in the raw editor. Unset means inherit; no defaults are written automatically.",
        )}
      </p>
      <Input
        placeholder={t("Search settings or native field names")}
        aria-label={t("Search settings or native field names")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {nativeConfigFields[format]
        .filter((field) =>
          `${field.path.join(".")} ${field.label} ${t(field.label)} ${t(field.description)}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        )
        .map((field) => (
          <NativeConfigFieldControl
            key={`${field.path.join(".")}:${String(nativeConfigValue(parsed, field.path))}`}
            field={field}
            value={nativeConfigValue(parsed, field.path)}
            content={content}
            format={format}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
    </div>
  );
}

function NativeConfigFieldControl({
  field,
  value,
  content,
  format,
  disabled,
  onChange,
}: {
  readonly field: NativeConfigField;
  readonly value: unknown;
  readonly content: string;
  readonly format: "toml" | "json";
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const t = useT();
  const text =
    value === undefined
      ? ""
      : typeof value === "string" || typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : JSON.stringify(value, (_key, item: unknown) =>
            typeof item === "bigint" ? item.toString() : item,
          );
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string | null>(null);
  const apply = (next: string) => {
    try {
      onChange(editNativeConfigField(content, format, field, next));
      setDraft(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The configuration operation failed.");
    }
  };
  return (
    <div className="space-y-1 border-b border-border pb-3">
      <p className="text-sm">{t(field.label)}</p>
      <p className="break-all font-mono text-xs">{field.path.join(".")}</p>
      <p className="text-xs text-muted-foreground">{t(field.description)}</p>
      {field.options ? (
        <Select
          value={text}
          disabled={disabled}
          onValueChange={(next) => {
            if (next !== null) apply(next);
          }}
        >
          <SelectTrigger aria-label={t(field.label)}>
            <SelectValue>{text || t("Inherit / native default")}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{t("Inherit / native default")}</SelectItem>
            {!field.options.includes(text) && text ? (
              <SelectItem value={text}>{text}</SelectItem>
            ) : null}
            {field.options.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : (
        <div className="flex gap-2">
          <Input
            aria-label={t(field.label)}
            inputMode="numeric"
            disabled={disabled}
            value={draft}
            placeholder={t("Inherit / native default")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || draft === text}
            onClick={() => apply(draft)}
          >
            {t("Set in draft")}
          </Button>
        </div>
      )}
      {!field.options ? (
        <p className="text-xs text-muted-foreground">
          {t("Editor range")}: {field.min}–{field.max}
        </p>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || value === undefined}
        onClick={() => apply("")}
      >
        {t("Remove override")}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {t(error)}
        </p>
      ) : null}
    </div>
  );
}
