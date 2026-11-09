/**
 * Remote control: whether server agents may use `win`, and — on the desktop
 * app — which servers this computer accepts commands from, where they may
 * run, and what has run. The agent toggle is a server setting; everything
 * else lives in the desktop's own settings and grant store.
 *
 * @module RemoteControlSettings
 */
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ThreadId,
  type DesktopExecLogEntry,
  type DesktopPathMapping,
  type RemoteControlConfigPatch,
  type RemoteControlGrant,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  FolderIcon,
  PlusIcon,
  RefreshCwIcon,
  UnplugIcon,
  XIcon,
} from "lucide-react";
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { isElectron } from "~/env";
import { useT } from "~/i18n";
import { cn } from "~/lib/utils";
import { useEnvironments, type EnvironmentPresentation } from "~/state/environments";
import { useThreadShell } from "~/state/entities";

import {
  bridgeErrorMessage,
  describeExecOutcome,
  formatAuditTime,
  formatDuration,
  isPosixAbsolutePath,
  isWindowsAbsolutePath,
  providerLabel,
} from "../remoteControl/remoteControl.logic";
import {
  REMOTE_CONTROL_AUDIT_LIMIT,
  readRemoteControlBridge,
  useEnabledRemoteEnvironmentIds,
  useRemoteControlAudit,
  useRemoteControlCapabilities,
  useRemoteControlConfig,
  useRemoteControlGrants,
} from "../remoteControl/useRemoteControl";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ScopedSwitch } from "./ScopedSwitch";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const LIST_ROW_CLASS = "flex items-center gap-3 border-t border-border/50 py-2.5";
const EMPTY_LIST_CLASS = "border-t border-border/50 py-2.5 text-sm text-muted-foreground";

export function RemoteControlSettings() {
  const bridgeAvailable = readRemoteControlBridge() !== null;
  return (
    <>
      <SettingsSection id="remote-control" title="Remote control">
        <AgentWinAccessRow />
        <ThisComputerSettings />
      </SettingsSection>
      {bridgeAvailable ? (
        <SettingsSection id="remote-control-history" title="Remote control activity">
          <AllowedThreadsRow />
          <RecentActivityRow />
        </SettingsSection>
      ) : null}
    </>
  );
}

function AgentWinAccessRow() {
  const { scope } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsRow
      {...searchableSetting("agent-win-access")}
      serverScoped
      settingKeys={["enableAgentWinAccess"]}
      description={
        projectScope
          ? "Allow agents in this project to run commands on a connected Windows computer with the win command. Applies when the agent session next starts."
          : "Allow agents to run commands on a connected Windows computer with the win command. Applies when the agent session next starts. Projects can override it."
      }
      resetAction={
        settings.enableAgentWinAccess !== DEFAULT_SERVER_SETTINGS.enableAgentWinAccess ? (
          <SettingResetButton
            label="default Windows access"
            onClick={() =>
              updateSettings({ enableAgentWinAccess: DEFAULT_SERVER_SETTINGS.enableAgentWinAccess })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentWinAccess"]}
          checked={settings.enableAgentWinAccess}
          aria-label="Agent Windows access"
          onCheckedChange={(checked) => updateSettings({ enableAgentWinAccess: Boolean(checked) })}
        />
      }
    />
  );
}

function ThisComputerSettings() {
  const t = useT();
  if (readRemoteControlBridge() === null) {
    return (
      <SettingsUnavailableGroup
        message={
          isElectron
            ? t("Update the desktop app to let agents run commands on this computer.")
            : t("Only available in the desktop app.")
        }
      >
        <SettingsRow
          title="This computer"
          description="Choose which servers may run commands here, and in which folders."
        />
      </SettingsUnavailableGroup>
    );
  }
  return <ThisComputerControls />;
}

function ThisComputerControls() {
  const t = useT();
  const bridge = readRemoteControlBridge()!;
  const config = useRemoteControlConfig();
  const enabledIds = useEnabledRemoteEnvironmentIds();
  const capabilities = useRemoteControlCapabilities();
  const { environments } = useEnvironments();
  const [disconnecting, setDisconnecting] = useState(false);
  const enabled = enabledIds.value ?? config.value?.enabledEnvironmentIds ?? [];

  const updateConfig = async (patch: RemoteControlConfigPatch): Promise<string | null> => {
    try {
      config.replace(await bridge.updateConfig(patch));
      return null;
    } catch (cause) {
      return bridgeErrorMessage(cause);
    }
  };

  const disconnectAll = async () => {
    setDisconnecting(true);
    try {
      await bridge.disconnectAll();
      toastManager.add({
        type: "success",
        title: t("Remote control turned off"),
        description: t("Running commands were stopped and waiting requests denied."),
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t("Couldn't turn off remote control"),
        description: bridgeErrorMessage(cause),
      });
    } finally {
      setDisconnecting(false);
    }
  };

  const rows = (
    <>
      <SettingsRow
        {...searchableSetting("remote-control-servers")}
        description="Servers turned on here can send commands to this computer. Each thread still asks before its first command."
        status={
          config.value ? (
            <>
              {t("Servers see this computer as")}{" "}
              <span className="font-medium text-foreground">{config.value.hostName}</span>
            </>
          ) : config.error ? (
            <span className="text-destructive-foreground">{config.error}</span>
          ) : null
        }
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={disconnecting || enabled.length === 0}
            onClick={() => void disconnectAll()}
          >
            <UnplugIcon className="size-3.5" />
            {t("Disconnect all")}
          </Button>
        }
      >
        <div className="pt-3 pb-2">
          {environments.length === 0 ? (
            <p className={EMPTY_LIST_CLASS}>{t("Add a server under Connections first.")}</p>
          ) : (
            environments.map((environment) => (
              <ServerSwitchRow
                key={environment.environmentId}
                environment={environment}
                enabled={enabled.includes(environment.environmentId)}
                onChange={async (next) => {
                  try {
                    await bridge.setEnvironmentEnabled(environment.environmentId, next);
                    enabledIds.reload();
                  } catch (cause) {
                    toastManager.add({
                      type: "error",
                      title: t("Couldn't change remote control"),
                      description: bridgeErrorMessage(cause),
                    });
                  }
                }}
              />
            ))
          )}
        </div>
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("remote-control-strict-mode")}
        description="Approve each command on its own instead of once per thread."
        control={
          <Switch
            aria-label="Ask for every command"
            disabled={!config.value}
            checked={config.value?.strictMode ?? false}
            onCheckedChange={(checked) => {
              void updateConfig({ strictMode: Boolean(checked) }).then((failure) => {
                if (failure) {
                  toastManager.add({
                    type: "error",
                    title: t("Couldn't save"),
                    description: failure,
                  });
                }
              });
            }}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("remote-control-folders")}
        description="Commands only run inside these folders and their subfolders. Folders in path mappings are allowed too."
      >
        <AllowedFoldersEditor
          allowlist={config.value?.allowlist ?? null}
          onSave={(allowlist) => updateConfig({ allowlist })}
        />
      </SettingsRow>
      <SettingsRow
        {...searchableSetting("remote-control-path-mappings")}
        description="Match folders on a server to folders here, so a command runs in the same project the agent is working in."
      >
        <PathMappingsEditor
          mappings={config.value?.mappings ?? null}
          onSave={(mappings) => updateConfig({ mappings })}
        />
      </SettingsRow>
    </>
  );

  // The executor is Windows-only; other desktops can still see the settings.
  return capabilities.value && !capabilities.value.exec ? (
    <SettingsUnavailableGroup message={t("Running commands is only supported on Windows.")}>
      {rows}
    </SettingsUnavailableGroup>
  ) : (
    rows
  );
}

function ServerSwitchRow({
  environment,
  enabled,
  onChange,
}: {
  environment: EnvironmentPresentation;
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  const t = useT();
  const [pending, setPending] = useState(false);
  const connected = environment.connection.phase === "connected";
  const agentAccessOff = environment.serverConfig?.settings.enableAgentWinAccess === false;
  const detail = connected
    ? (environment.displayUrl ?? t("Connected"))
    : t(connectionStatusText(environment.connection));
  return (
    <div className={LIST_ROW_CLASS}>
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          connected ? "bg-success" : "bg-muted-foreground/30",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{environment.label}</p>
        <p className="truncate text-xs text-muted-foreground">
          {detail}
          {enabled && agentAccessOff ? (
            <span className="text-warning-foreground">
              {" · "}
              {t("Agent Windows access is off by default on this server")}
            </span>
          ) : null}
        </p>
      </div>
      <Switch
        aria-label={t("Accept commands from {server}").replace("{server}", environment.label)}
        checked={enabled}
        disabled={pending}
        onCheckedChange={(checked) => {
          setPending(true);
          void onChange(Boolean(checked)).finally(() => setPending(false));
        }}
      />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        }
      />
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

function RemoveButton(props: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <IconButton {...props}>
      <XIcon className="size-3.5" />
    </IconButton>
  );
}

function FieldError({ children }: { children: ReactNode }) {
  return children ? <p className="pt-1.5 text-xs text-destructive-foreground">{children}</p> : null;
}

function AllowedFoldersEditor({
  allowlist,
  onSave,
}: {
  allowlist: readonly string[] | null;
  onSave: (allowlist: string[]) => Promise<string | null>;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (next: string[]) => {
    setSaving(true);
    const failure = await onSave(next);
    setSaving(false);
    setError(failure);
    return failure === null;
  };
  const add = async () => {
    const value = draft.trim();
    if (!value || !allowlist) return;
    if (!isWindowsAbsolutePath(value)) {
      setError(t("Enter a full Windows path, such as D:\\Projects."));
      return;
    }
    if (await save([...allowlist, value])) setDraft("");
  };
  return (
    <div className="pt-3 pb-2">
      {allowlist === null ? null : allowlist.length === 0 ? (
        <p className={EMPTY_LIST_CLASS}>
          {t("No folders yet. Commands can't run until you add one.")}
        </p>
      ) : (
        allowlist.map((folder) => (
          <div key={folder} className={LIST_ROW_CLASS}>
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 font-mono text-xs break-all">{folder}</span>
            <RemoveButton
              label={t("Remove folder")}
              disabled={saving}
              onClick={() => void save(allowlist.filter((entry) => entry !== folder))}
            />
          </div>
        ))
      )}
      <div className="flex items-center gap-2 border-t border-border/50 pt-3">
        <Input
          size="sm"
          font="mono"
          aria-label={t("Folder to allow")}
          aria-invalid={error ? true : undefined}
          placeholder="D:\Projects"
          value={draft}
          disabled={allowlist === null || saving}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void add();
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!draft.trim() || allowlist === null || saving}
          onClick={() => void add()}
        >
          <PlusIcon className="size-3.5" />
          {t("Add folder")}
        </Button>
      </div>
      <FieldError>{error}</FieldError>
    </div>
  );
}

const EMPTY_MAPPING_DRAFT = { serverPath: "", winPath: "", syncSession: "" };

function PathMappingsEditor({
  mappings,
  onSave,
}: {
  mappings: readonly DesktopPathMapping[] | null;
  onSave: (mappings: DesktopPathMapping[]) => Promise<string | null>;
}) {
  const t = useT();
  const [draft, setDraft] = useState(EMPTY_MAPPING_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async (next: DesktopPathMapping[]) => {
    setSaving(true);
    const failure = await onSave(next);
    setSaving(false);
    setError(failure);
    return failure === null;
  };
  const serverPath = draft.serverPath.trim();
  const winPath = draft.winPath.trim();
  const syncSession = draft.syncSession.trim();
  const add = async () => {
    if (!mappings || !serverPath || !winPath) return;
    if (!isPosixAbsolutePath(serverPath)) {
      setError(t("The server path must be absolute, such as /home/dev/project."));
      return;
    }
    if (!isWindowsAbsolutePath(winPath)) {
      setError(t("Enter a full Windows path, such as D:\\Projects."));
      return;
    }
    const mapping: DesktopPathMapping = syncSession
      ? { serverPath, winPath, syncSession }
      : { serverPath, winPath };
    if (await save([...mappings, mapping])) setDraft(EMPTY_MAPPING_DRAFT);
  };
  const setField = (field: keyof typeof EMPTY_MAPPING_DRAFT) => (value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setError(null);
  };
  const onEnter = (event: KeyboardEvent) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void add();
  };
  return (
    <div className="pt-3 pb-2">
      {mappings === null ? null : mappings.length === 0 ? (
        <p className={EMPTY_LIST_CLASS}>
          {t("No mappings. Agents must pass --cwd with a Windows folder.")}
        </p>
      ) : (
        mappings.map((mapping) => (
          <div key={`${mapping.serverPath}\n${mapping.winPath}`} className={LIST_ROW_CLASS}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 font-mono text-xs @min-[34rem]/settings-row:flex-row @min-[34rem]/settings-row:items-center @min-[34rem]/settings-row:gap-2">
              <span className="min-w-0 break-all text-muted-foreground">{mapping.serverPath}</span>
              <ArrowRightIcon className="hidden size-3 shrink-0 text-muted-foreground/70 @min-[34rem]/settings-row:block" />
              <span className="min-w-0 break-all">{mapping.winPath}</span>
            </div>
            {mapping.syncSession ? (
              <Badge variant="outline" className="shrink-0">
                {t("Sync")}: {mapping.syncSession}
              </Badge>
            ) : null}
            <RemoveButton
              label={t("Remove mapping")}
              disabled={saving}
              onClick={() => void save(mappings.filter((entry) => entry !== mapping))}
            />
          </div>
        ))
      )}
      <div className="grid gap-2 border-t border-border/50 pt-3 @min-[34rem]/settings-row:grid-cols-2">
        <Input
          size="sm"
          font="mono"
          aria-label={t("Server path")}
          aria-invalid={error ? true : undefined}
          placeholder="/home/dev/project"
          value={draft.serverPath}
          disabled={mappings === null || saving}
          onChange={(event) => setField("serverPath")(event.target.value)}
          onKeyDown={onEnter}
        />
        <Input
          size="sm"
          font="mono"
          aria-label={t("Windows path")}
          aria-invalid={error ? true : undefined}
          placeholder="D:\Projects\project"
          value={draft.winPath}
          disabled={mappings === null || saving}
          onChange={(event) => setField("winPath")(event.target.value)}
          onKeyDown={onEnter}
        />
        <Input
          size="sm"
          aria-label={t("Mutagen session (optional)")}
          placeholder={t("Mutagen session (optional)")}
          value={draft.syncSession}
          disabled={mappings === null || saving}
          onChange={(event) => setField("syncSession")(event.target.value)}
          onKeyDown={onEnter}
        />
        <Button
          size="sm"
          variant="outline"
          className="justify-self-start @min-[34rem]/settings-row:justify-self-end"
          disabled={!serverPath || !winPath || mappings === null || saving}
          onClick={() => void add()}
        >
          <PlusIcon className="size-3.5" />
          {t("Add mapping")}
        </Button>
      </div>
      <FieldError>{error}</FieldError>
    </div>
  );
}

function AllowedThreadsRow() {
  const t = useT();
  const grants = useRemoteControlGrants();
  const revoke = async (grant: RemoteControlGrant) => {
    try {
      await readRemoteControlBridge()?.revokeGrant({
        environmentId: grant.environmentId,
        threadId: grant.threadId,
      });
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t("Couldn't revoke"),
        description: bridgeErrorMessage(cause),
      });
    }
  };
  const list = grants.value;
  return (
    <SettingsRow
      {...searchableSetting("remote-control-threads")}
      description="Threads that may run commands without asking. Permission lapses after 7 days without use."
      status={
        grants.error ? <span className="text-destructive-foreground">{grants.error}</span> : null
      }
    >
      <div className="pt-3 pb-2">
        {list === null ? null : list.length === 0 ? (
          <p className={EMPTY_LIST_CLASS}>{t("No threads are allowed right now.")}</p>
        ) : (
          list.map((grant) => (
            <GrantRow
              key={`${grant.environmentId}\n${grant.threadId}`}
              grant={grant}
              onRevoke={() => void revoke(grant)}
            />
          ))
        )}
      </div>
    </SettingsRow>
  );
}

function GrantRow({ grant, onRevoke }: { grant: RemoteControlGrant; onRevoke: () => void }) {
  const t = useT();
  const { presentationById } = useEnvironments();
  const environmentId = EnvironmentId.make(grant.environmentId);
  const thread = useThreadShell(scopeThreadRef(environmentId, ThreadId.make(grant.threadId)));
  const serverLabel = presentationById.get(environmentId)?.entry.target.label;
  const meta = [
    serverLabel,
    providerLabel(grant.provider),
    grant.label,
    t("Last used {time}").replace("{time}", formatAuditTime(grant.lastUsedAt, new Date())),
  ].filter(Boolean);
  return (
    <div className={LIST_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">
          {thread?.title ?? <span className="font-mono text-xs">{grant.threadId}</span>}
        </p>
        <p className="truncate text-xs text-muted-foreground">{meta.join(" · ")}</p>
      </div>
      <Button size="xs" variant="ghost-destructive" onClick={onRevoke}>
        {t("Revoke")}
      </Button>
    </div>
  );
}

function RecentActivityRow() {
  const t = useT();
  const audit = useRemoteControlAudit();
  const now = new Date();
  return (
    <SettingsRow
      {...searchableSetting("remote-control-activity")}
      description={t(
        "The last {count} commands agents ran or tried to run here, including denied ones.",
      ).replace("{count}", String(REMOTE_CONTROL_AUDIT_LIMIT))}
      status={
        audit.error ? <span className="text-destructive-foreground">{audit.error}</span> : null
      }
      control={
        <IconButton
          label={t("Refresh")}
          disabled={audit.loading}
          onClick={() => void audit.refresh()}
        >
          <RefreshCwIcon className={cn("size-3.5", audit.loading && "animate-spin")} />
        </IconButton>
      }
    >
      <div className="pt-3 pb-2">
        {audit.entries === null ? null : audit.entries.length === 0 ? (
          <p className={EMPTY_LIST_CLASS}>{t("Nothing has run yet.")}</p>
        ) : (
          audit.entries.map((entry) => (
            <ActivityRow key={entry.requestId} entry={entry} now={now} />
          ))
        )}
      </div>
    </SettingsRow>
  );
}

function ActivityRow({ entry, now }: { entry: DesktopExecLogEntry; now: Date }) {
  const t = useT();
  const outcome = describeExecOutcome(entry);
  const meta = [
    entry.outcome === "error" ? entry.errorCode : null,
    entry.winCwd,
    providerLabel(entry.provider),
    entry.label,
    entry.durationMs === null ? null : formatDuration(entry.durationMs),
  ].filter(Boolean);
  return (
    <div className="flex items-start gap-3 border-t border-border/50 py-2.5">
      <div className="w-20 shrink-0 pt-0.5">
        <Badge variant={outcome.tone}>
          {t(outcome.label).replace("{code}", outcome.code ?? "")}
        </Badge>
      </div>
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 font-mono text-xs leading-5 break-all">
          {entry.mode === "powershell" ? (
            <span className="text-muted-foreground">ps&gt; </span>
          ) : null}
          {entry.summary}
        </p>
        <p className="text-xs break-all text-muted-foreground">{meta.join(" · ")}</p>
      </div>
      <time
        dateTime={entry.startedAt}
        className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums"
      >
        {formatAuditTime(entry.startedAt, now)}
      </time>
    </div>
  );
}
