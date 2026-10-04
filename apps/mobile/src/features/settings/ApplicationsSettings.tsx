import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { View, TextInput, Pressable, Linking } from "react-native";
import {
  ApplicationPublish,
  ProviderInstanceId,
  type Application,
  type ApplicationResponse,
  type ApplicationRequest,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { resources } from "../../state/resources";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMobileT } from "../../i18n";

const isPublication = Schema.is(ApplicationPublish);
export function ApplicationsSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const t = useMobileT();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const instances = Object.keys(settings?.providerInstances ?? {}).filter(
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
        if (value.application) setSelected(value.application);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not manage applications.");
    } finally {
      setBusy(false);
    }
  };
  const action = (label: string, callback: () => void, disabled = false) => (
    <Pressable
      key={label}
      disabled={busy || disabled}
      accessibilityRole="button"
      onPress={callback}
      className="px-2 py-2"
    >
      <Text className={busy || disabled ? "text-foreground-muted" : "text-primary"}>
        {t(label)}
      </Text>
    </Pressable>
  );
  function publish() {
    const input = {
      projectRoot,
      manifestPath,
      ...(selected ? { applicationId: selected.id } : { name }),
      hostname: hostname || null,
    };
    if (!isPublication(input)) {
      setError("Enter a project directory and a valid application name.");
      return;
    }
    void request({ action: "publish", input });
  }
  return (
    <View className="gap-3">
      <Text className="font-semibold">{t("Application publishing")}</Text>
      <Text className="text-foreground-muted">
        {t(
          "Publish business projects with Docker Compose. Applications survive chat and T3 restarts. The controlling T3 framework is protected.",
        )}
      </Text>
      <View className="flex-row flex-wrap">
        {[...new Set([instanceId, ...instances])].map((id) =>
          action(`${instanceId === id ? "✓ " : ""}${id}`, () => {
            setInstanceId(id);
            setApps([]);
            setSelected(null);
            setResult(null);
          }),
        )}
      </View>
      {action("Refresh applications", () => void request({ action: "list", input: {} }))}
      {apps.map((app) => (
        <View key={app.id}>
          <Text>
            {app.name} · {t(app.state)} · {app.projectRoot}
          </Text>
          {action("Manage", () => {
            setSelected(app);
            setProjectRoot(app.projectRoot);
            setName(app.name);
            setHostname(app.hostname ?? "");
            void request({ action: "status", input: { applicationId: app.id } });
          })}
        </View>
      ))}
      {selected ? (
        <View className="gap-2">
          <Text className="font-semibold">{selected.name}</Text>
          {selected.url ? (
            action(selected.url, () => void Linking.openURL(selected.url!))
          ) : (
            <Text>{t("No public route")}</Text>
          )}
          <View className="flex-row flex-wrap">
            {(["start", "stop", "restart"] as const).map((command) =>
              action(
                command === "start" ? "Start" : command === "stop" ? "Stop" : "Restart",
                () =>
                  void request({
                    action: "control",
                    input: { applicationId: selected.id, action: command },
                  }),
              ),
            )}
            {action(
              "Status / wait for operation",
              () =>
                void request({
                  action: "status",
                  input: {
                    applicationId: selected.id,
                    ...(result?.operation ? { operationId: result.operation.id, wait: true } : {}),
                  },
                }),
            )}
            {action(
              "Inspect release",
              () => void request({ action: "inspect", input: { applicationId: selected.id } }),
            )}
            {action(
              "Runtime logs",
              () =>
                void request({
                  action: "logs",
                  input: { applicationId: selected.id, kind: "runtime", limit: 100 },
                }),
            )}
            {action(
              "Operation logs",
              () =>
                void request({
                  action: "logs",
                  input: { applicationId: selected.id, kind: "build", limit: 100 },
                }),
            )}
            {action(
              "Release history",
              () => void request({ action: "releases", input: { applicationId: selected.id } }),
            )}
            {action(
              "Withdraw application",
              () => void request({ action: "unpublish", input: { applicationId: selected.id } }),
            )}
            {action("New application", () => {
              setSelected(null);
              setResult(null);
              setName("");
              setHostname("");
            })}
          </View>
        </View>
      ) : null}
      {result?.operation ? (
        <Text>
          {t("Operation")} {result.operation.id} · {t(result.operation.stage)}
          {result.operation.error
            ? ` · ${result.operation.error.code}: ${result.operation.error.message}`
            : ""}
        </Text>
      ) : null}
      {result?.releases?.map((release) => (
        <View key={release.id}>
          <Text>
            {release.createdAt} · {release.status} · {release.snapshotDigest.slice(0, 12)}
          </Text>
          {action(
            "Restore release",
            () =>
              void request({
                action: "rollback",
                input: { applicationId: release.applicationId, releaseId: release.id },
              }),
            release.status !== "ready",
          )}
        </View>
      ))}
      {result?.logs ? (
        <View>
          <Text selectable>
            {result.logs.entries.map((entry) => entry.text).join("\n")}
            {result.logs.truncated ? `\n${t("Log output was truncated.")}` : ""}
          </Text>
          {selected && result.logs.cursor
            ? action(
                "Next log page",
                () =>
                  void request({
                    action: "logs",
                    input: {
                      applicationId: selected.id,
                      kind: result.logs?.operationId ? "build" : "runtime",
                      ...(result.logs?.operationId ? { operationId: result.logs.operationId } : {}),
                      cursor: result.logs?.cursor ?? "",
                      limit: 100,
                    },
                  }),
              )
            : null}
        </View>
      ) : null}
      {result?.containers || result?.configuration || result?.release ? (
        <Text selectable>
          {JSON.stringify(
            {
              containers: result.containers,
              runtimeAvailable: result.runtimeAvailable,
              release: result.release,
              configuration: result.configuration,
            },
            null,
            2,
          )}
        </Text>
      ) : null}
      <Text>{t("Project directory")}</Text>
      <TextInput
        value={projectRoot}
        editable={!busy && !selected}
        onChangeText={setProjectRoot}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded border border-border bg-background px-3 py-2 text-foreground"
      />
      <Text>{t("Compose file")}</Text>
      <TextInput
        value={manifestPath}
        editable={!busy}
        onChangeText={setManifestPath}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded border border-border bg-background px-3 py-2 text-foreground"
      />
      {!selected ? (
        <>
          <Text>{t("Application name")}</Text>
          <TextInput
            value={name}
            editable={!busy}
            onChangeText={setName}
            autoCapitalize="none"
            autoCorrect={false}
            className="rounded border border-border bg-background px-3 py-2 text-foreground"
          />
        </>
      ) : null}
      <Text>{t("Public hostname (optional)")}</Text>
      <TextInput
        value={hostname}
        editable={!busy}
        onChangeText={setHostname}
        autoCapitalize="none"
        autoCorrect={false}
        className="rounded border border-border bg-background px-3 py-2 text-foreground"
      />
      <Text className="text-foreground-muted">
        {t(
          "Declare healthchecks and container-only ports in Compose. Updates replace the running version; rollback preserves persistent data. An empty hostname publishes privately.",
        )}
      </Text>
      {action(selected ? "Publish new release" : "Publish application", publish)}
      {error ? (
        <Text accessibilityRole="alert" className="text-red-600">
          {t(error)}
        </Text>
      ) : null}
    </View>
  );
}
