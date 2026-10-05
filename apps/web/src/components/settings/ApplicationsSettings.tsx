import { DeploymentAuthorizations } from "./DeploymentAuthorizations";
import { ApplicationDiagnostics } from "./ApplicationDiagnostics";
import { useState } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  ApplicationPublish,
  ProviderInstanceId,
  type Application,
  type ApplicationBackend,
  type ApplicationDeploymentProfile,
  type ApplicationResponse,
  type ApplicationRequest,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { resources } from "../../state/resources";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

const isPublication = Schema.is(ApplicationPublish);
export function ApplicationsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useT();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const candidates = Object.keys(settings?.providerInstances ?? {}).filter(
    (id) => settings?.providerInstances?.[ProviderInstanceId.make(id)]?.execution,
  );
  const [instanceId, setInstanceId] = useState("codex");
  const [apps, setApps] = useState<ReadonlyArray<Application>>([]);
  const [selected, setSelected] = useState<Application | null>(null);
  const [result, setResult] = useState<ApplicationResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [manifestPath, setManifestPath] = useState("compose.yaml");
  const [backend, setBackend] = useState<ApplicationBackend>("docker-compose");
  const [deploymentProfile, setDeploymentProfile] = useState("");
  const [profiles, setProfiles] = useState<ReadonlyArray<ApplicationDeploymentProfile>>([]);
  const activeProfile = profiles.find((item) => item.id === deploymentProfile);
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const execute = useAtomCommand(resources.applications, {
    reportFailure: false,
    reportDefect: false,
  });
  const request = async (request: ApplicationRequest) => {
    setBusy(true);
    setError("");
    try {
      const response = await execute({
        environmentId,
        input: { instanceId: ProviderInstanceId.make(instanceId), request },
      });
      if (AsyncResult.isFailure(response)) throw squashAtomCommandFailure(response);
      const value = Option.getOrNull(AsyncResult.value(response));
      if (value) {
        setResult(value);
        if (value.applications) setApps(value.applications);
        if (value.deploymentProfiles) setProfiles(value.deploymentProfiles);
        if (value.release) setManifestPath(value.release.manifestPath);
        if (value.application) setSelected(value.application);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not manage applications.");
    } finally {
      setBusy(false);
    }
  };
  const publish = () => {
    const input = {
      projectRoot,
      manifestPath,
      backend,
      ...(backend === "systemd"
        ? { deploymentProfile: selected?.deploymentProfile ?? deploymentProfile }
        : {}),
      ...(selected ? { applicationId: selected.id } : { name }),
      hostname: backend === "systemd" ? null : hostname || null,
    };
    if (backend === "systemd" && !input.deploymentProfile) {
      setError("Select a registered deployment profile.");
      return;
    }
    if (!isPublication(input)) {
      setError("Enter a project directory and a valid application name.");
      return;
    }
    void request({ action: "publish", input });
  };
  return (
    <SettingsSection title={t("Application publishing")}>
      <div className="flex flex-col gap-3 p-4">
        <p className="text-sm text-muted-foreground">
          {t(
            "Publish with Docker Compose or a registered systemd deployment profile. Applications survive chat and T3 restarts.",
          )}
        </p>
        <label>
          {t("Provider instance")}{" "}
          <select
            value={instanceId}
            disabled={busy}
            onChange={(event) => {
              setInstanceId(event.target.value);
              setProfiles([]);
              setProjectRoot("");
              setName("");
              setHostname("");
              setDeploymentProfile("");
              setBackend("docker-compose");
              setManifestPath("compose.yaml");
              setSelected(null);
              setResult(null);
              setApps([]);
            }}
          >
            {[...new Set([instanceId, ...candidates])].map((id) => (
              <option key={id} value={id}>
                {settings?.providerInstances?.[ProviderInstanceId.make(id)]?.displayName ?? id}
              </option>
            ))}
          </select>
        </label>
        <DeploymentAuthorizations
          key={`${environmentId}:${instanceId}`}
          environmentId={environmentId}
          instanceId={instanceId}
          onProfiles={setProfiles}
        />
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void request({ action: "list", input: {} })}
          >
            {t("Refresh applications")}
          </Button>
        </div>
        {apps.map((app) => (
          <div className="flex flex-wrap items-center gap-2" key={app.id}>
            <span className="mr-auto">
              {app.name} · {t(app.state)} · {app.projectRoot}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected(app);
                setBackend(app.backend ?? "docker-compose");
                setDeploymentProfile(app.deploymentProfile ?? "");
                setManifestPath(app.backend === "systemd" ? "application.yaml" : "compose.yaml");
                setProjectRoot(app.projectRoot);
                setName(app.name);
                setHostname(app.hostname ?? "");
                void request({ action: "status", input: { applicationId: app.id } });
              }}
            >
              {t("Manage")}
            </Button>
          </div>
        ))}
        {selected ? (
          <div className="flex flex-wrap gap-2">
            <strong>{selected.name}</strong>
            {selected.url ? (
              <a href={selected.url} target="_blank" rel="noreferrer">
                {selected.url}
              </a>
            ) : (
              <span>{t("No public route")}</span>
            )}
            {(["start", "stop", "restart"] as const).map((action) => (
              <Button
                key={action}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void request({ action: "control", input: { applicationId: selected.id, action } })
                }
              >
                {t(action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart")}
              </Button>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void request({
                  action: "status",
                  input: {
                    applicationId: selected.id,
                    ...(result?.operation ? { operationId: result.operation.id, wait: true } : {}),
                  },
                })
              }
            >
              {t("Status / wait for operation")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void request({ action: "inspect", input: { applicationId: selected.id } })
              }
            >
              {t("Inspect release")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void request({
                  action: "logs",
                  input: { applicationId: selected.id, kind: "runtime", limit: 100 },
                })
              }
            >
              {t("Runtime logs")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void request({
                  action: "logs",
                  input: {
                    applicationId: selected.id,
                    kind: "build",
                    limit: 100,
                    ...(result?.operation ? { operationId: result.operation.id } : {}),
                  },
                })
              }
            >
              {t("Operation logs")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void request({ action: "releases", input: { applicationId: selected.id } })
              }
            >
              {t("Release history")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void request({ action: "unpublish", input: { applicationId: selected.id } })
              }
            >
              {t("Withdraw application")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setResult(null);
                setBackend("docker-compose");
                setDeploymentProfile("");
                setManifestPath("compose.yaml");
                setName("");
                setHostname("");
              }}
            >
              {t("New application")}
            </Button>
          </div>
        ) : null}
        {result?.operation ? (
          <p role="status">
            {t("Operation")} {result.operation.id} · {t(result.operation.stage)}
            {result.operation.error
              ? ` · ${result.operation.error.code}: ${result.operation.error.message}`
              : ""}
            {result.operation.recovery ? ` · ${t("Recovery")}: ${result.operation.recovery}` : ""}
          </p>
        ) : null}
        <ApplicationDiagnostics
          items={[...(result?.operation?.diagnostics ?? []), ...(result?.diagnostics ?? [])]}
        />
        {result?.releases?.map((release) => (
          <div className="flex flex-wrap items-center gap-2" key={release.id}>
            <span className="mr-auto">
              {release.createdAt} · {release.status} · {release.snapshotDigest.slice(0, 12)}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || release.status !== "ready"}
              onClick={() =>
                void request({
                  action: "rollback",
                  input: { applicationId: release.applicationId, releaseId: release.id },
                })
              }
            >
              {t("Restore release")}
            </Button>
          </div>
        ))}
        {result?.logs ? (
          <>
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
              {result.logs.entries.map((entry) => entry.text).join("\n")}
              {result.logs.truncated ? `\n${t("Log output was truncated.")}` : ""}
            </pre>
            {selected && result.logs.cursor ? (
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void request({
                      action: "logs",
                      input: {
                        applicationId: selected.id,
                        kind: result.logs?.operationId ? "build" : "runtime",
                        ...(result.logs?.operationId
                          ? { operationId: result.logs.operationId }
                          : {}),
                        cursor: result.logs?.cursor ?? "",
                        limit: 100,
                      },
                    })
                  }
                >
                  {t("Next log page")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
        {result?.containers || result?.units || result?.configuration || result?.release ? (
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">
            {JSON.stringify(
              {
                containers: result.containers,
                units: result.units,
                runtimeAvailable: result.runtimeAvailable,
                release: result.release,
                configuration: result.configuration,
              },
              null,
              2,
            )}
          </pre>
        ) : null}
        <label>
          {t("Deployment backend")}{" "}
          <select
            value={backend}
            disabled={busy || !!selected}
            onChange={(event) => {
              const next = event.target.value === "systemd" ? "systemd" : "docker-compose";
              setBackend(next);
              setDeploymentProfile("");
              setManifestPath(next === "systemd" ? "application.yaml" : "compose.yaml");
            }}
          >
            <option value="docker-compose">Docker Compose</option>
            <option value="systemd">systemd</option>
          </select>
        </label>
        {backend === "systemd" ? (
          <>
            <label>
              {t("Deployment profile")}{" "}
              <select
                value={deploymentProfile}
                disabled={busy || !!selected}
                onChange={(event) => {
                  const profile = profiles.find((item) => item.id === event.target.value);
                  setDeploymentProfile(event.target.value);
                  if (profile) {
                    setProjectRoot(profile.projectRoot);
                    setName(profile.applicationName);
                  }
                }}
              >
                <option value="">{t("Select a registered profile")}</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.id} · {profile.runtimeUser}
                  </option>
                ))}
              </select>
            </label>
            {profiles.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t(
                  "Create a deployment authorization above, or ask your Harness to prepare one for review.",
                )}
              </p>
            ) : null}
            {activeProfile ? (
              <p className="text-sm text-muted-foreground">
                {t("Runtime budget")}: {activeProfile.runtime.memoryMiB} MiB · CPU{" "}
                {activeProfile.runtime.cpuPercent}% · {t("Build budget")}:{" "}
                {activeProfile.build.memoryMiB} MiB · CPU {activeProfile.build.cpuPercent}%
              </p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              {t(
                "Native services do not require a domain or HTTP port. Root runtime is confined to the application's private filesystem.",
              )}
            </p>
          </>
        ) : null}
        <div className="flex flex-col gap-2">
          <label>
            {t("Project directory")}
            <Input
              value={projectRoot}
              disabled={busy || !!selected || backend === "systemd"}
              onChange={(event) => setProjectRoot(event.target.value)}
              placeholder="/home/dev/workspaces/my-blog"
            />
          </label>
          <label>
            {t(backend === "systemd" ? "Application manifest" : "Compose file")}
            <Input
              value={manifestPath}
              disabled={busy}
              onChange={(event) => setManifestPath(event.target.value)}
            />
          </label>
          {!selected ? (
            <label>
              {t("Application name")}
              <Input
                value={name}
                disabled={busy || backend === "systemd"}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          ) : null}
          {backend === "docker-compose" ? (
            <label>
              {t("Public hostname (optional)")}
              <Input
                value={hostname}
                disabled={busy}
                onChange={(event) => setHostname(event.target.value)}
              />
            </label>
          ) : null}
          <p className="text-xs text-muted-foreground">
            {t(
              "Updates replace the running version; rollback preserves persistent data. Native services use the registered runtime user, private filesystem and resource budget.",
            )}
          </p>
          <div>
            <Button size="sm" disabled={busy} onClick={publish}>
              {t(selected ? "Publish new release" : "Publish application")}
            </Button>
          </div>
        </div>
        {error ? <p role="alert">{t(error)}</p> : null}
      </div>
    </SettingsSection>
  );
}
