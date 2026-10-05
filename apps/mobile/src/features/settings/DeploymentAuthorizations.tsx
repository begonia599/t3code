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
import { useMobileT } from "../../i18n";
import { View, TextInput, Pressable, Switch } from "react-native";
import { AppText as Text } from "../../components/AppText";

function AuthorizationButton({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const t = useMobileT();
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      className="px-2 py-2"
    >
      <Text className={disabled ? "text-foreground-muted" : "text-primary"}>{t(label)}</Text>
    </Pressable>
  );
}

export function DeploymentAuthorizations({
  environmentId,
  instanceId,
  onProfiles,
}: {
  environmentId: EnvironmentId;
  instanceId: string;
  onProfiles: (profiles: ReadonlyArray<ApplicationDeploymentProfile>) => void;
}) {
  const t = useMobileT();
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
    <View className="gap-1">
      <Text>
        {item.id} · {item.applicationName}
      </Text>
      <Text>
        {t("Project directory")}: {item.projectRoot}
      </Text>
      <Text>
        {t("Provider instance")}: {item.instances?.join(", ") ?? instanceId}
      </Text>
      <Text>
        {t("Runtime user")}: {item.runtimeUser} · {t("Network")}: {item.networkNamespace}
      </Text>
      <Text>
        {t("Allowed TCP ports")}: {item.listenPorts.join(", ") || t("None")}
      </Text>
      {(["build", "runtime"] as const).map((kind) => (
        <Text key={kind}>
          {t(kind === "build" ? "Build budget" : "Runtime budget")}:{" "}
          {deploymentBudgetFields
            .map(([key, label]) => `${t(label)}: ${item[kind][key]}`)
            .join(" · ")}
        </Text>
      ))}
    </View>
  );
  return (
    <View className="gap-3 rounded-lg border border-border p-3">
      <Text className="font-semibold">{t("Deployment authorizations")}</Text>
      <Text>
        {t(
          "Create an authorization here, or ask your Harness to prepare a request for you to review. Approval does not publish or start an application.",
        )}
      </Text>
      <Text>{t("Runtime timeout limits readiness checks, not the service lifetime.")}</Text>
      <View className="flex-row flex-wrap">
        <AuthorizationButton
          label={"Refresh authorizations"}
          onPress={() => void run({ action: "deployment-requests", input: {} })}
          disabled={busy}
        />
        <AuthorizationButton
          label={"New deployment authorization"}
          onPress={() => {
            setForm(deploymentFormDefaults);
            setPorts("");
            setEditing(true);
            setReview(null);
            setRevoking(null);
          }}
          disabled={busy}
        />
      </View>
      {busy ? <Text accessibilityLiveRegion="polite">{t("Loading…")}</Text> : null}
      {error ? <Text accessibilityRole="alert">{t(error)}</Text> : null}
      {!busy && !error && pending.length === 0 ? (
        <Text>{t("No pending deployment requests.")}</Text>
      ) : null}
      {pending.map((item) => (
        <View key={item.requestId} className="gap-1">
          <Text>
            {item.proposal.profileId} · {item.runtimeUser} · {item.proposal.projectRoot}
          </Text>
          <AuthorizationButton
            label={"Review request"}
            onPress={() => {
              setReview(item);
              setEditing(false);
              setRevoking(null);
              setConfirmRoot(false);
            }}
            disabled={busy}
          />
        </View>
      ))}
      {editing ? (
        <View className="gap-3">
          {(
            [
              ["profileId", "Profile name"],
              ["projectRoot", "Project directory"],
              ["applicationName", "Application name"],
            ] as const
          ).map(([key, label]) => (
            <View key={key}>
              <Text>{t(label)}</Text>
              <TextInput
                accessibilityLabel={t(label)}
                editable={!busy}
                autoCapitalize="none"
                autoCorrect={false}
                className="rounded border border-border px-3 py-2 text-foreground"
                value={form[key]}
                onChangeText={(value) => setForm({ ...form, [key]: value })}
              />
            </View>
          ))}
          <Text>{t("Runtime user")}</Text>
          <View className="flex-row flex-wrap">
            {(
              [
                ["owner", "Normal T3 host user"],
                ["root", "root"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ checked: form.runtimeIdentity === value }}
                disabled={busy}
                onPress={() => setForm({ ...form, runtimeIdentity: value })}
                className="px-2 py-2"
              >
                <Text>
                  {form.runtimeIdentity === value ? "✓ " : ""}
                  {t(label)}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text>{t("Network")}</Text>
          <View className="flex-row flex-wrap">
            {(
              [
                ["instance", "Use this Harness network"],
                ["host", "Host network"],
              ] as const
            ).map(([value, label]) => (
              <Pressable
                key={value}
                accessibilityRole="radio"
                accessibilityState={{ checked: form.network === value }}
                disabled={busy}
                onPress={() => setForm({ ...form, network: value })}
                className="px-2 py-2"
              >
                <Text>
                  {form.network === value ? "✓ " : ""}
                  {t(label)}
                </Text>
              </Pressable>
            ))}
          </View>
          <View>
            <Text>{t("Allowed TCP ports")}</Text>
            <TextInput
              accessibilityLabel={t("Allowed TCP ports")}
              editable={!busy}
              className="rounded border border-border px-3 py-2 text-foreground"
              value={ports}
              placeholder={t("Leave empty for an outbound bot")}
              onChangeText={setPorts}
            />
          </View>
          {(["build", "runtime"] as const).map((kind) => (
            <View key={kind} className="gap-2">
              <Text className="font-semibold">
                {t(kind === "build" ? "Build budget" : "Runtime budget")}
              </Text>
              {deploymentBudgetFields.map(([key, label]) => (
                <View key={key}>
                  <Text>{t(label)}</Text>
                  <TextInput
                    accessibilityLabel={`${t(kind === "build" ? "Build budget" : "Runtime budget")} ${t(label)}`}
                    editable={!busy}
                    keyboardType="numeric"
                    className="rounded border border-border px-3 py-2 text-foreground"
                    value={Number.isNaN(form[kind][key]) ? "" : String(form[kind][key])}
                    onChangeText={(value) =>
                      setForm({
                        ...form,
                        [kind]: { ...form[kind], [key]: value === "" ? Number.NaN : Number(value) },
                      })
                    }
                  />
                </View>
              ))}
            </View>
          ))}
          <View className="flex-row">
            <AuthorizationButton label={"Review authorization"} onPress={prepare} disabled={busy} />
            <AuthorizationButton
              label={"Cancel"}
              onPress={() => setEditing(false)}
              disabled={busy}
            />
          </View>
        </View>
      ) : null}
      {review ? (
        <View className="gap-3 rounded border border-border p-3">
          {summary({
            id: review.proposal.profileId,
            ...review.proposal,
            runtimeUser: review.runtimeUser,
            networkNamespace: review.networkNamespace,
            rootFilesystem: "private",
          })}
          <Text>
            {t(
              "The application uses a private filesystem and PID namespace. Host administration and T3 resources remain protected.",
            )}
          </Text>
          {review.proposal.runtimeIdentity === "root" ? (
            <View className="gap-1">
              <Text>
                {t("I authorize this application to run as root inside its private filesystem.")}
              </Text>
              <Switch
                accessibilityLabel={t(
                  "I authorize this application to run as root inside its private filesystem.",
                )}
                disabled={busy}
                value={confirmRoot}
                onValueChange={setConfirmRoot}
              />
            </View>
          ) : null}
          <View className="flex-row flex-wrap">
            <AuthorizationButton
              label={"Approve authorization"}
              onPress={() =>
                void run(
                  {
                    action: "approve",
                    input: { requestId: review.requestId, revision: review.revision, confirmRoot },
                  },
                  true,
                )
              }
              disabled={busy || (review.proposal.runtimeIdentity === "root" && !confirmRoot)}
            />
            <AuthorizationButton
              label={"Adjust request"}
              onPress={() => {
                setForm(review.proposal);
                setPorts(review.proposal.listenPorts.join(", "));
                setReview(null);
                setEditing(true);
                setConfirmRoot(false);
              }}
              disabled={busy}
            />
            <AuthorizationButton
              label={"Reject request"}
              onPress={() =>
                void run(
                  {
                    action: "reject",
                    input: { requestId: review.requestId, revision: review.revision },
                  },
                  true,
                )
              }
              disabled={busy}
            />
            <AuthorizationButton
              label={"Cancel"}
              onPress={() => {
                setReview(null);
                setConfirmRoot(false);
              }}
              disabled={busy}
            />
          </View>
        </View>
      ) : null}
      <Text className="font-semibold">{t("Granted authorizations")}</Text>
      {!busy && !error && profiles.length === 0 ? (
        <Text>{t("No active deployment authorizations.")}</Text>
      ) : null}
      {profiles.map((item) => (
        <View key={item.id} className="gap-2 border-t border-border pt-2">
          {summary(item)}
          <AuthorizationButton
            label={"Revoke authorization"}
            onPress={() => {
              setRevoking(item);
              setReview(null);
              setEditing(false);
            }}
            disabled={busy || !item.revision}
          />
        </View>
      ))}
      {revoking ? (
        <View className="gap-2">
          <Text>
            {revoking.id}:{" "}
            {t(
              "Stop the application before revoking. This removes this profile for all listed instances; release history and application data are retained.",
            )}
          </Text>
          <View className="flex-row flex-wrap">
            <AuthorizationButton
              label={"Confirm revocation"}
              onPress={() => {
                if (revoking.revision)
                  void run(
                    {
                      action: "revoke",
                      input: { profileId: revoking.id, revision: revoking.revision },
                    },
                    true,
                  );
              }}
              disabled={busy}
            />
            <AuthorizationButton
              label={"Cancel"}
              onPress={() => setRevoking(null)}
              disabled={busy}
            />
          </View>
        </View>
      ) : null}
      {requests.some((item) => item.status !== "pending") ? (
        <Text className="font-semibold">{t("Recent deployment requests")}</Text>
      ) : null}
      {requests
        .filter((item) => item.status !== "pending")
        .slice(0, 10)
        .map((item) => (
          <Text key={item.requestId} className="text-xs text-foreground-muted">
            {item.proposal.profileId} · {t(item.status)} · {item.createdAt}
          </Text>
        ))}
    </View>
  );
}
