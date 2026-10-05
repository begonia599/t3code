import { useEffect, useRef, useState } from "react";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Option from "effect/Option";
import {
  ProviderInstanceId,
  type ApplicationDeploymentProfile,
  type ApplicationRequest,
  type ApplicationResponse,
  type DeploymentAdminRequest,
  type DeploymentAuthorizationRequest,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  deploymentBudgetFields,
  deploymentFormDefaults,
  deploymentProposalFromForm,
  type DeploymentForm,
} from "@t3tools/client-runtime/state/resources";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { resources } from "../../state/resources";
import { useAtomCommand } from "../../state/use-atom-command";
import { useT } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function DeploymentAuthorizations({
  environmentId,
  instanceId,
  onProfiles,
}: {
  environmentId: EnvironmentId;
  instanceId: string;
  onProfiles: (profiles: ReadonlyArray<ApplicationDeploymentProfile>) => void;
}) {
  const t = useT();
  const [requests, setRequests] = useState<ReadonlyArray<DeploymentAuthorizationRequest>>([]);
  const [profiles, setProfiles] = useState<ReadonlyArray<ApplicationDeploymentProfile>>([]);
  const [form, setForm] = useState<DeploymentForm>(deploymentFormDefaults);
  const [ports, setPorts] = useState("");
  const [editing, setEditing] = useState(false);
  const [review, setReview] = useState<DeploymentAuthorizationRequest | null>(null);
  const [revoking, setRevoking] = useState<ApplicationDeploymentProfile | null>(null);
  const [confirmRoot, setConfirmRoot] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const execute = useAtomCommand(resources.applications, {
    reportFailure: false,
    reportDefect: false,
  });
  const administer = useAtomCommand(resources.deploymentAdmin, {
    reportFailure: false,
    reportDefect: false,
  });
  useEffect(() => {
    mounted.current = true;
    let active = true;
    void execute({
      environmentId,
      input: {
        instanceId: ProviderInstanceId.make(instanceId),
        request: { action: "deployment-requests", input: {} },
      },
    })
      .then((response) => {
        if (!active) return;
        if (AsyncResult.isFailure(response)) throw squashAtomCommandFailure(response);
        const value = Option.getOrNull(AsyncResult.value(response));
        setRequests(value?.deploymentRequests ?? []);
        setProfiles(value?.deploymentProfiles ?? []);
        onProfiles(value?.deploymentProfiles ?? []);
      })
      .catch((error: unknown) => {
        if (active)
          setError(
            error instanceof Error ? error.message : "Could not load deployment authorizations.",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, [environmentId, instanceId, execute, onProfiles]);
  async function run(request: ApplicationRequest | DeploymentAdminRequest, admin = false) {
    setBusy(true);
    setError("");
    try {
      const input = { instanceId: ProviderInstanceId.make(instanceId), request };
      const response = admin
        ? await administer({
            environmentId,
            input: { ...input, request: request as DeploymentAdminRequest },
          })
        : await execute({
            environmentId,
            input: { ...input, request: request as ApplicationRequest },
          });
      if (!mounted.current) return;
      if (AsyncResult.isFailure(response)) throw squashAtomCommandFailure(response);
      const value: ApplicationResponse | null = Option.getOrNull(AsyncResult.value(response));
      if (value?.deploymentRequests) setRequests(value.deploymentRequests);
      if (value?.deploymentProfiles) {
        setProfiles(value.deploymentProfiles);
        onProfiles(value.deploymentProfiles);
      }
      setReview(null);
      setRevoking(null);
      setConfirmRoot(false);
      if (request.action === "deployment-propose") {
        setEditing(false);
        setReview(
          value?.deploymentRequests?.find(
            (item) =>
              item.status === "pending" && item.proposal.profileId === request.input.profileId,
          ) ?? null,
        );
      }
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error ? error.message : "Could not save deployment authorization.",
        );
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  function prepare() {
    const proposal = deploymentProposalFromForm(form, ports);
    if (!proposal) {
      setError("Check the project directory, names, ports and resource limits.");
      return;
    }
    void run({ action: "deployment-propose", input: proposal });
  }
  const pending = requests.filter((item) => item.status === "pending");
  const summary = (item: ApplicationDeploymentProfile) => (
    <div className="space-y-1 text-sm">
      <p>
        {item.id} · {item.applicationName}
      </p>
      <p>
        {t("Project directory")}: {item.projectRoot}
      </p>
      <p>
        {t("Provider instance")}: {item.instances?.join(", ") ?? instanceId}
      </p>
      <p>
        {t("Runtime user")}: {item.runtimeUser} · {t("Network")}: {item.networkNamespace}
      </p>
      <p>
        {t("Allowed TCP ports")}: {item.listenPorts.join(", ") || t("None")}
      </p>
      {(["build", "runtime"] as const).map((kind) => (
        <p key={kind}>
          {t(kind === "build" ? "Build budget" : "Runtime budget")}:{" "}
          {deploymentBudgetFields
            .map(([key, label]) => `${t(label)}: ${item[kind][key]}`)
            .join(" · ")}
        </p>
      ))}
    </div>
  );
  return (
    <section
      className="space-y-3 rounded-lg border p-3"
      aria-label={t("Deployment authorizations")}
    >
      <h3 className="font-medium">{t("Deployment authorizations")}</h3>
      <p className="text-sm text-muted-foreground">
        {t(
          "Create an authorization here, or ask your Harness to prepare a request for you to review. Approval does not publish or start an application.",
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        {t("Runtime timeout limits readiness checks, not the service lifetime.")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => void run({ action: "deployment-requests", input: {} })}
        >
          {t("Refresh authorizations")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setForm(deploymentFormDefaults);
            setPorts("");
            setEditing(true);
            setReview(null);
            setRevoking(null);
          }}
        >
          {t("New deployment authorization")}
        </Button>
      </div>
      {busy ? <p role="status">{t("Loading…")}</p> : null}
      {error ? <p role="alert">{t(error)}</p> : null}
      {!busy && !error && pending.length === 0 ? (
        <p className="text-sm">{t("No pending deployment requests.")}</p>
      ) : null}
      {pending.map((item) => (
        <div key={item.requestId} className="flex flex-wrap items-center gap-2">
          <span>
            {item.proposal.profileId} · {item.runtimeUser} · {item.proposal.projectRoot}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setReview(item);
              setEditing(false);
              setRevoking(null);
              setConfirmRoot(false);
            }}
          >
            {t("Review request")}
          </Button>
        </div>
      ))}
      {editing ? (
        <fieldset disabled={busy} className="space-y-3">
          {(
            [
              ["profileId", "Profile name"],
              ["projectRoot", "Project directory"],
              ["applicationName", "Application name"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="block space-y-1">
              {t(label)}
              <Input
                value={form[key]}
                onChange={(event) => setForm({ ...form, [key]: event.target.value })}
              />
            </label>
          ))}
          <label className="block">
            {t("Runtime user")}{" "}
            <select
              value={form.runtimeIdentity}
              onChange={(event) =>
                setForm({
                  ...form,
                  runtimeIdentity: event.target.value === "root" ? "root" : "owner",
                })
              }
            >
              <option value="owner">{t("Normal T3 host user")}</option>
              <option value="root">root</option>
            </select>
          </label>
          <label className="block">
            {t("Network")}{" "}
            <select
              value={form.network}
              onChange={(event) =>
                setForm({ ...form, network: event.target.value === "host" ? "host" : "instance" })
              }
            >
              <option value="instance">{t("Use this Harness network")}</option>
              <option value="host">{t("Host network")}</option>
            </select>
          </label>
          <label className="block space-y-1">
            {t("Allowed TCP ports")}
            <Input
              value={ports}
              placeholder={t("Leave empty for an outbound bot")}
              onChange={(event) => setPorts(event.target.value)}
            />
          </label>
          {(["build", "runtime"] as const).map((kind) => (
            <fieldset key={kind} className="space-y-2">
              <legend>{t(kind === "build" ? "Build budget" : "Runtime budget")}</legend>
              <div className="grid grid-cols-2 gap-2">
                {deploymentBudgetFields.map(([key, label, min, max]) => (
                  <label key={key}>
                    {t(label)}
                    <Input
                      type="number"
                      min={min}
                      max={max}
                      step={1}
                      value={Number.isNaN(form[kind][key]) ? "" : form[kind][key]}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          [kind]: {
                            ...form[kind],
                            [key]:
                              event.target.value === "" ? Number.NaN : Number(event.target.value),
                          },
                        })
                      }
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
          <div className="flex gap-2">
            <Button size="sm" onClick={prepare}>
              {t("Review authorization")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("Cancel")}
            </Button>
          </div>
        </fieldset>
      ) : null}
      {review ? (
        <div className="space-y-3 rounded border p-3">
          {summary({
            id: review.proposal.profileId,
            ...review.proposal,
            runtimeUser: review.runtimeUser,
            networkNamespace: review.networkNamespace,
            rootFilesystem: "private",
          })}
          <p className="text-sm">
            {t(
              "The application uses a private filesystem and PID namespace. Host administration and T3 resources remain protected.",
            )}
          </p>
          {review.proposal.runtimeIdentity === "root" ? (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmRoot}
                disabled={busy}
                onChange={(event) => setConfirmRoot(event.target.checked)}
              />
              {t("I authorize this application to run as root inside its private filesystem.")}
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={busy || (review.proposal.runtimeIdentity === "root" && !confirmRoot)}
              onClick={() =>
                void run(
                  {
                    action: "approve",
                    input: { requestId: review.requestId, revision: review.revision, confirmRoot },
                  },
                  true,
                )
              }
            >
              {t("Approve authorization")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setForm(review.proposal);
                setPorts(review.proposal.listenPorts.join(", "));
                setReview(null);
                setEditing(true);
                setConfirmRoot(false);
              }}
            >
              {t("Adjust request")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(
                  {
                    action: "reject",
                    input: { requestId: review.requestId, revision: review.revision },
                  },
                  true,
                )
              }
            >
              {t("Reject request")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setReview(null);
                setConfirmRoot(false);
              }}
            >
              {t("Cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      <h4 className="font-medium">{t("Granted authorizations")}</h4>
      {!busy && !error && profiles.length === 0 ? (
        <p className="text-sm">{t("No active deployment authorizations.")}</p>
      ) : null}
      {profiles.map((item) => (
        <div key={item.id} className="space-y-2 border-t pt-2">
          {summary(item)}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !item.revision}
            onClick={() => {
              setRevoking(item);
              setReview(null);
              setEditing(false);
            }}
          >
            {t("Revoke authorization")}
          </Button>
        </div>
      ))}
      {revoking ? (
        <div className="space-y-2" role="alert">
          <p>
            {revoking.id}:{" "}
            {t(
              "Stop the application before revoking. This removes this profile for all listed instances; release history and application data are retained.",
            )}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => {
                if (revoking.revision)
                  void run(
                    {
                      action: "revoke",
                      input: { profileId: revoking.id, revision: revoking.revision },
                    },
                    true,
                  );
              }}
            >
              {t("Confirm revocation")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRevoking(null)}>
              {t("Cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      {requests.some((item) => item.status !== "pending") ? (
        <h4 className="font-medium">{t("Recent deployment requests")}</h4>
      ) : null}
      {requests
        .filter((item) => item.status !== "pending")
        .slice(0, 10)
        .map((item) => (
          <p key={item.requestId} className="text-xs text-muted-foreground">
            {item.proposal.profileId} · {t(item.status)} · {item.createdAt}
          </p>
        ))}
    </section>
  );
}
