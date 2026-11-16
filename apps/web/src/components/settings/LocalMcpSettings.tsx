/**
 * MCP servers on this PC: local MCP servers (Unity MCP and the like) whose
 * tools agents on connected servers can call. The desktop app starts them,
 * keeps their tool lists, and forwards calls; this section only lists them
 * and edits their configs. Pasting the JSON snippet from a server's README
 * fills the form in.
 *
 * @module LocalMcpSettings
 */
import type {
  LocalMcpBridge,
  LocalMcpProbeResult,
  LocalMcpServerConfig,
  LocalMcpServerView,
} from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardPasteIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { useT } from "~/i18n";
import { cn } from "~/lib/utils";

import { bridgeErrorMessage } from "../remoteControl/remoteControl.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  describeLocalMcpTransport,
  draftFromConfig,
  draftToConfig,
  emptyLocalMcpDraft,
  localMcpStatusPresentation,
  parsePastedLocalMcpConfig,
  toolCountText,
  uniqueLocalMcpId,
  withDraftName,
  type LocalMcpDraft,
  type LocalMcpDraftErrors,
} from "./localMcp.logic";
import { SettingsSection } from "./settingsLayout";

export const LOCAL_MCP_SETTINGS_ID = "local-mcp";

export function readLocalMcpBridge(): LocalMcpBridge | null {
  if (!isElectron || typeof window === "undefined") return null;
  const bridge = window.desktopBridge?.localMcp;
  return bridge && typeof bridge.list === "function" ? bridge : null;
}

/** Local MCP forwarding ships with the Windows desktop app. */
export function localMcpAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    window.desktopBridge?.getClientPlatform?.() === "win32" &&
    readLocalMcpBridge() !== null
  );
}

function useLocalMcpServers(bridge: LocalMcpBridge) {
  const [servers, setServers] = useState<readonly LocalMcpServerView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    bridge.list().then(
      (next) => live && setServers(next),
      (cause: unknown) => live && setError(bridgeErrorMessage(cause)),
    );
    const unsubscribe = bridge.onChanged((next) => {
      if (live) setServers(next);
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [bridge]);
  return { servers, error, replace: setServers };
}

type Editing = { readonly kind: "new" } | { readonly kind: "edit"; readonly id: string } | null;

export function LocalMcpSettings() {
  const t = useT();
  const bridge = readLocalMcpBridge()!;
  const { servers, error, replace } = useLocalMcpServers(bridge);
  const [editing, setEditing] = useState<Editing>(null);
  const ids = new Set((servers ?? []).map((view) => view.config.id));

  return (
    <SettingsSection
      id={LOCAL_MCP_SETTINGS_ID}
      title="MCP servers on this PC"
      headerAction={
        editing?.kind === "new" ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={servers === null}
            onClick={() => setEditing({ kind: "new" })}
          >
            <PlusIcon className="size-3.5" />
            {t("Add MCP server")}
          </Button>
        )
      }
    >
      <div className="px-3 py-3 sm:px-4">
        <p className="text-xs text-muted-foreground">
          {t(
            "Agents on your servers can use the tools of MCP servers running on this PC, such as Unity MCP. The tools run on this PC.",
          )}
        </p>
        <div className="pt-2">
          {error ? (
            <p className="border-t border-border/50 py-2.5 text-xs text-destructive-foreground">
              {error}
            </p>
          ) : servers === null ? null : servers.length === 0 && editing?.kind !== "new" ? (
            <p className="border-t border-border/50 py-2.5 text-sm text-muted-foreground">
              {t("No MCP servers yet.")}
            </p>
          ) : (
            servers.map((view) =>
              editing?.kind === "edit" && editing.id === view.config.id ? (
                <LocalMcpEditor
                  key={view.config.id}
                  bridge={bridge}
                  initial={draftFromConfig(view.config)}
                  takenIds={new Set([...ids].filter((id) => id !== view.config.id))}
                  onDone={(next) => {
                    if (next) replace(next);
                    setEditing(null);
                  }}
                />
              ) : (
                <LocalMcpRow
                  key={view.config.id}
                  bridge={bridge}
                  view={view}
                  editDisabled={editing !== null}
                  onEdit={() => setEditing({ kind: "edit", id: view.config.id })}
                  onReplace={replace}
                />
              ),
            )
          )}
          {editing?.kind === "new" ? (
            <LocalMcpEditor
              bridge={bridge}
              initial={null}
              takenIds={ids}
              onDone={(next) => {
                if (next) replace(next);
                setEditing(null);
              }}
            />
          ) : null}
        </div>
      </div>
    </SettingsSection>
  );
}

function LocalMcpRow({
  bridge,
  view,
  editDisabled,
  onEdit,
  onReplace,
}: {
  bridge: LocalMcpBridge;
  view: LocalMcpServerView;
  editDisabled: boolean;
  onEdit: () => void;
  onReplace: (servers: readonly LocalMcpServerView[]) => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const { config } = view;
  const presentation = localMcpStatusPresentation(view.status, config.enabled);
  const tools = toolCountText(view);

  const run = async (
    failureTitle: string,
    action: () => Promise<readonly LocalMcpServerView[]>,
  ) => {
    setBusy(true);
    try {
      onReplace(await action());
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t(failureTitle),
        description: bridgeErrorMessage(cause),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border-t border-border/50 py-2.5">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            presentation.dotClassName,
            presentation.pulse && "animate-status-pulse",
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{config.name}</span>
            <span className="shrink-0 font-mono text-2xs text-muted-foreground">{config.id}__</span>
          </p>
          <p className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "shrink-0",
                presentation.tone === "success" && "text-success-foreground",
                presentation.tone === "error" && "text-destructive-foreground",
              )}
            >
              {t(presentation.label)}
            </span>
            {config.enabled && view.tools.length > 0 ? (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  className="inline-flex shrink-0 items-center gap-0.5 rounded-sm hover:text-foreground focus-visible:outline-1 focus-visible:outline-ring"
                  aria-expanded={toolsOpen}
                  onClick={() => setToolsOpen((open) => !open)}
                >
                  {t(tools.text).replace("{count}", String(tools.count))}
                  <ChevronDownIcon
                    aria-hidden
                    className={cn("size-3 transition-transform", toolsOpen && "rotate-180")}
                  />
                </button>
              </>
            ) : null}
            <span aria-hidden>·</span>
            <span className="min-w-0 truncate font-mono text-2xs">
              {describeLocalMcpTransport(config)}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {config.enabled ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-sm"
                    variant="ghost-muted"
                    aria-label={t("Restart")}
                    disabled={busy}
                    onClick={() => void run("Couldn't restart", () => bridge.restart(config.id))}
                  />
                }
              >
                <RefreshCwIcon className={cn("size-3.5", busy && "animate-spin")} />
              </TooltipTrigger>
              <TooltipPopup side="top">{t("Restart and reload tools")}</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost-muted"
                  aria-label={t("Edit")}
                  disabled={busy || editDisabled}
                  onClick={onEdit}
                />
              }
            >
              <PencilIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">{t("Edit")}</TooltipPopup>
          </Tooltip>
          <Button
            size="xs"
            variant="ghost-destructive"
            disabled={busy}
            onClick={() => setRemoveOpen(true)}
          >
            {t("Remove")}
          </Button>
          <Switch
            className="ms-1"
            aria-label={t("Use {name}").replace("{name}", config.name)}
            checked={config.enabled}
            disabled={busy}
            onCheckedChange={(checked) =>
              void run("Couldn't change the MCP server", () =>
                bridge.setEnabled(config.id, Boolean(checked)),
              )
            }
          />
        </div>
      </div>

      {config.enabled && view.status === "failed" && view.error ? (
        <pre className="ms-5 mt-1.5 max-h-24 overflow-auto rounded-md bg-destructive/6 px-2.5 py-1.5 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-destructive-foreground">
          {view.error}
        </pre>
      ) : null}

      {toolsOpen && config.enabled ? (
        <ul className="ms-5 mt-2 flex flex-wrap gap-1">
          {view.tools.map((tool) => (
            <li key={tool.name}>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-block rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-2xs text-foreground/80" />
                  }
                >
                  {tool.name}
                </TooltipTrigger>
                {tool.description ? (
                  <TooltipPopup side="top" className="max-w-80">
                    {tool.description}
                  </TooltipPopup>
                ) : null}
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : null}

      <AlertDialog open={removeOpen} onOpenChange={(next) => !busy && setRemoveOpen(next)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("Remove {name}?").replace("{name}", config.name)}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Agents can no longer use its tools. The MCP server itself stays installed on this PC.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button variant="outline" />}>
              {t("Cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() =>
                void run("Couldn't remove the MCP server", () => bridge.remove(config.id)).finally(
                  () => setRemoveOpen(false),
                )
              }
            >
              {t("Remove")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

type ProbeState =
  | { readonly kind: "idle" }
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly result: LocalMcpProbeResult };

function LocalMcpEditor({
  bridge,
  initial,
  takenIds,
  onDone,
}: {
  bridge: LocalMcpBridge;
  /** null = new server. */
  initial: LocalMcpDraft | null;
  takenIds: ReadonlySet<string>;
  onDone: (servers: readonly LocalMcpServerView[] | null) => void;
}) {
  const t = useT();
  const isNew = initial === null;
  const [draft, setDraft] = useState<LocalMcpDraft>(initial ?? emptyLocalMcpDraft());
  const [errors, setErrors] = useState<LocalMcpDraftErrors>({});
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<LocalMcpDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setErrors({});
    setProbe({ kind: "idle" });
  };

  const applyPaste = (text: string) => {
    setPaste(text);
    if (text.trim() === "") {
      setPasteNote(null);
      return;
    }
    const parsed = parsePastedLocalMcpConfig(text);
    if (!parsed.ok) {
      setPasteNote({ ok: false, text: t(parsed.error) });
      return;
    }
    const first = parsed.drafts[0]!;
    setDraft({ ...first, id: uniqueLocalMcpId(first.id, takenIds) });
    setErrors({});
    setProbe({ kind: "idle" });
    setPasteNote({
      ok: true,
      text:
        parsed.drafts.length === 1
          ? t("Filled in from the pasted config. Check it, then save.")
          : t("Found {count} servers; filled in the first one.").replace(
              "{count}",
              String(parsed.drafts.length),
            ),
    });
  };

  const validated = (): LocalMcpServerConfig | null => {
    const result = draftToConfig(draft, takenIds);
    if (result.ok) return result.config;
    setErrors(result.errors);
    return null;
  };

  const test = async () => {
    const config = validated();
    if (!config) return;
    setProbe({ kind: "running" });
    try {
      setProbe({ kind: "done", result: await bridge.probe(config) });
    } catch (cause) {
      setProbe({ kind: "done", result: { ok: false, error: bridgeErrorMessage(cause) } });
    }
  };

  const save = async () => {
    const config = validated();
    if (!config) return;
    setSaving(true);
    try {
      onDone(await bridge.upsert(config));
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t("Couldn't save the MCP server"),
        description: bridgeErrorMessage(cause),
      });
      setSaving(false);
    }
  };

  const fieldError = (field: keyof LocalMcpDraftErrors) => {
    const error = errors[field];
    return error ? t(error.message).replace("{line}", String(error.line ?? "")) : undefined;
  };

  return (
    <div className="border-t border-border/50 py-3">
      <div className="space-y-3.5 rounded-xl border border-border/70 bg-muted/24 p-3 sm:p-4">
        <p className="text-sm font-medium">
          {isNew ? t("Add MCP server") : t("Edit {name}").replace("{name}", initial.name)}
        </p>

        {isNew ? (
          <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <ClipboardPasteIcon aria-hidden className="size-3.5" />
              {t("Paste the MCP config from the server's setup guide to fill this in")}
            </label>
            <Textarea
              size="sm"
              font="mono"
              rows={3}
              spellCheck={false}
              aria-label={t("MCP config JSON")}
              placeholder={
                '{ "mcpServers": { "unity": { "command": "uv", "args": ["run", "server.py"] } } }'
              }
              value={paste}
              onChange={(event) => applyPaste(event.target.value)}
            />
            {pasteNote ? (
              <p
                className={cn(
                  "flex items-center gap-1 text-xs",
                  pasteNote.ok ? "text-success-foreground" : "text-destructive-foreground",
                )}
              >
                {pasteNote.ok ? <CheckIcon aria-hidden className="size-3.5" /> : null}
                {pasteNote.text}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t("Name")} error={fieldError("name")}>
            <Input
              size="sm"
              aria-label={t("Name")}
              value={draft.name}
              onChange={(event) => {
                setDraft((current) => {
                  const next = withDraftName(current, event.target.value);
                  return next.idEdited
                    ? next
                    : { ...next, id: uniqueLocalMcpId(next.id, takenIds) };
                });
                setErrors({});
              }}
            />
          </Field>
          <Field
            label={t("Tool prefix")}
            error={fieldError("id")}
            hint={draft.id ? <ToolNameExample id={draft.id} /> : undefined}
          >
            <Input
              size="sm"
              font="mono"
              aria-label={t("Tool prefix")}
              value={draft.id}
              onChange={(event) => update({ id: event.target.value, idEdited: true })}
            />
          </Field>
        </div>

        <ToggleGroup
          aria-label={t("How the server runs")}
          variant="segmented"
          value={[draft.kind]}
          onValueChange={(next) => {
            const kind = next[0];
            if (kind === "stdio" || kind === "http") update({ kind });
          }}
        >
          <Toggle value="stdio">{t("Start a command")}</Toggle>
          <Toggle value="http">{t("Connect to a URL")}</Toggle>
        </ToggleGroup>

        {draft.kind === "stdio" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("Command")} error={fieldError("command")}>
              <Input
                size="sm"
                font="mono"
                aria-label={t("Command")}
                value={draft.command}
                onChange={(event) => update({ command: event.target.value })}
              />
            </Field>
            <Field label={t("Working folder")} optional>
              <Input
                size="sm"
                font="mono"
                aria-label={t("Working folder")}
                placeholder={t("Defaults to your user folder")}
                value={draft.cwd}
                onChange={(event) => update({ cwd: event.target.value })}
              />
            </Field>
            <Field label={t("Arguments")} hint={t("One per line")} optional>
              <Textarea
                size="sm"
                font="mono"
                rows={4}
                spellCheck={false}
                aria-label={t("Arguments")}
                placeholder={"run\n--directory\nC:\\UnityMcpServer\\src\nserver.py"}
                value={draft.args}
                onChange={(event) => update({ args: event.target.value })}
              />
            </Field>
            <Field
              label={t("Environment variables")}
              hint={<code className="font-mono">NAME=value</code>}
              error={fieldError("env")}
              optional
            >
              <Textarea
                size="sm"
                font="mono"
                rows={4}
                spellCheck={false}
                aria-label={t("Environment variables")}
                value={draft.env}
                onChange={(event) => update({ env: event.target.value })}
              />
            </Field>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t("URL")} error={fieldError("url")}>
              <Input
                size="sm"
                font="mono"
                aria-label={t("URL")}
                placeholder="http://127.0.0.1:8080/mcp"
                value={draft.url}
                onChange={(event) => update({ url: event.target.value })}
              />
            </Field>
            <Field
              label={t("Headers")}
              hint={<code className="font-mono">Name: value</code>}
              error={fieldError("headers")}
              optional
            >
              <Textarea
                size="sm"
                font="mono"
                rows={2}
                spellCheck={false}
                aria-label={t("Headers")}
                value={draft.headers}
                onChange={(event) => update({ headers: event.target.value })}
              />
            </Field>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/50 pt-3">
          <ProbeStatus probe={probe} />
          <div className="ms-auto flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => onDone(null)}>
              {t("Cancel")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={saving || probe.kind === "running"}
              onClick={() => void test()}
            >
              {t("Test")}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? <Spinner className="size-3.5" /> : null}
              {t("Save")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProbeStatus({ probe }: { probe: ProbeState }) {
  const t = useT();
  if (probe.kind === "idle") return null;
  if (probe.kind === "running") {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        {t("Starting the server…")}
      </p>
    );
  }
  const { result } = probe;
  if (!result.ok) {
    return (
      <p className="min-w-0 flex-1 basis-56 text-xs wrap-anywhere text-destructive-foreground">
        {result.error}
      </p>
    );
  }
  const count = result.tools.length;
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-xs text-success-foreground">
      <CheckIcon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {t(count === 1 ? "Works · 1 tool" : "Works · {count} tools").replace(
          "{count}",
          String(count),
        )}
        {result.serverName ? ` · ${result.serverName}` : ""}
      </span>
    </p>
  );
}

function ToolNameExample({ id }: { id: string }) {
  const t = useT();
  const [before = "", after = ""] = t("Agents see tools as {example}").split("{example}");
  return (
    <>
      {before}
      <code className="font-mono text-foreground/80">{id}__tool_name</code>
      {after}
    </>
  );
}

function Field({
  label,
  hint,
  error,
  optional = false,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | undefined;
  optional?: boolean;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <div className="min-w-0 space-y-1">
      <p className="flex items-baseline gap-1.5 text-xs font-medium">
        {label}
        {optional ? (
          <span className="font-normal text-muted-foreground">{t("Optional")}</span>
        ) : null}
      </p>
      {children}
      {error ? (
        <p className="text-xs text-destructive-foreground">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
