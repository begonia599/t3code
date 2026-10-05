import type { ApplicationDiagnostic } from "@t3tools/contracts";
import { View, ScrollView } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useMobileT } from "../../i18n";

export function ApplicationDiagnostics({ items }: { items: ReadonlyArray<ApplicationDiagnostic> }) {
  const t = useMobileT();
  if (!items.length) return null;
  return (
    <View className="gap-3">
      <Text className="font-semibold">{t("Deployment diagnostics")}</Text>
      {items.map((item) => (
        <View key={item.id} className="gap-1 rounded border border-border p-3">
          <Text>
            {t(item.phase)} {item.step !== undefined ? ` · ${t("Step")} ${item.step}` : ""}
            {item.commandExitCode !== undefined
              ? ` · ${t("Launcher exit")}: ${item.commandExitCode}`
              : ""}
            {item.cancelled ? ` · ${t("Timed out or cancelled.")}` : ""}
          </Text>
          <Text selectable>{item.unit}</Text>
          <Text>
            {item.capturedAt} · {t("Release")} {item.releaseId}
          </Text>
          <Text selectable>
            {Object.entries(item.state)
              .map(([key, value]) => `${key}=${value}`)
              .join(" · ")}
          </Text>
          {!item.stateAvailable ? <Text>{t("Systemd state unavailable.")}</Text> : null}
          {item.journalStatus !== "available" ? (
            <Text>
              {t(
                item.journalStatus === "empty"
                  ? "No journal entries were found for this attempt."
                  : "Journal could not be read.",
              )}
            </Text>
          ) : null}
          <ScrollView style={{ maxHeight: 256 }} nestedScrollEnabled>
            <Text selectable>
              {[item.stdout, item.stderr, item.journal, item.collectionError]
                .filter(Boolean)
                .join("\n")}
            </Text>
          </ScrollView>
          {item.truncated ? <Text>{t("Log output was truncated.")}</Text> : null}
        </View>
      ))}
    </View>
  );
}
