import { useState } from "react";
import { Pressable, View } from "react-native";
import { subscriptionEstimationIssueLabels, type EnvironmentId } from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";
import { AppText as Text } from "../../components/AppText";
import { useMobileT } from "../../i18n";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function SubscriptionEstimates({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const t = useMobileT();
  const [before, setBefore] = useState<{ before: string; beforeId: string } | undefined>();
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const query = useEnvironmentQuery(
    serverEnvironment.subscriptionEstimation({ environmentId, input: before ?? {} }),
  );
  const exclude = useAtomCommand(serverEnvironment.excludeSubscriptionSample);
  const report = query.data;
  const button = (text: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={action}
      className="rounded-lg border border-border p-3"
    >
      <Text>{t(text)}</Text>
    </Pressable>
  );
  return (
    <View className="gap-3 rounded-xl border border-border p-4">
      <Text className="font-semibold">
        {t("Subscription API-equivalent estimates")} · {label}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t(
          "Only T3 activity is recorded. Concurrent use elsewhere cannot be ruled out. Estimates depend on the observed model mix, not an official balance.",
        )}
      </Text>
      <Text className="text-xs text-muted-foreground">
        {t(
          "A one-point quota change can give a preliminary estimate. Codex running tasks update as usage arrives. Missing usage is shown separately as a known-cost reference, not a full allowance.",
        )}
      </Text>
      {button("Refresh", query.refresh)}
      {query.error || error ? <Text>{t("Could not update subscription estimates.")}</Text> : null}
      {!report?.cycles.length ? (
        <Text>{t("Collecting samples. New tasks record quota before and after execution.")}</Text>
      ) : null}
      {report?.cycles.map((c) => (
        <View key={c.id} className="gap-1">
          <Text>
            {c.label} · {c.windowLabel} · {new Date(c.resetsAt).toLocaleString()}
          </Text>
          <Text>
            {t("T3 recorded API equivalent")}: {formatUsd(c.observedCostUsd)}
          </Text>
          <Text>
            {t("Valid samples / quota coverage")}: {c.samples} / {c.usedPercentagePoints.toFixed(2)}
            %
          </Text>
          <Text>
            {t("Estimated full cycle")}:{" "}
            {c.estimatedTotalUsd === null
              ? t(
                  c.scope === "unsupported"
                    ? "Quota scope is not supported for calibration"
                    : c.knownCostTotalUsd != null
                      ? "Complete usage unavailable; see known-cost reference below"
                      : "Waiting for a measurable quota change with usable token costs",
                )
              : formatUsd(c.estimatedTotalUsd)}
          </Text>
          {c.estimatedTotalUsd !== null && c.preliminary ? (
            <Text>{t("Preliminary estimate; task still running or sample coverage is small")}</Text>
          ) : null}
          <Text>
            {t("Estimated remaining at last observation")}:{" "}
            {c.estimatedRemainingUsd === null ? "—" : formatUsd(c.estimatedRemainingUsd)}
          </Text>
          {c.estimatedTotalUsd === null && c.knownCostTotalUsd != null ? (
            <Text>
              {t("Known-cost reference only; missing usage is not included")}: {t("Full cycle")}{" "}
              {formatUsd(c.knownCostTotalUsd)} · {t("Remaining")}{" "}
              {formatUsd(c.knownCostRemainingUsd ?? 0)}
              {" · "}
              {t("Observed quota change")}: {c.knownCostPercentagePoints?.toFixed(2)}%
            </Text>
          ) : null}
        </View>
      ))}
      {button("Sample records and external activity", () => setExpanded(!expanded))}
      {expanded
        ? report?.samples.map((s) => (
            <View key={s.id} className="gap-2 border-t border-border py-2">
              <Text>
                {new Date(s.startedAt).toLocaleString()} →{" "}
                {s.endedAt ? new Date(s.endedAt).toLocaleString() : t("Running")}
              </Text>
              <Text>
                {s.models.join(", ")} · {formatUsd(s.costUsd)}
              </Text>
              <Text>
                {s.before
                  .map(
                    (w) =>
                      `${w.label} (${t("Used quota")}): ${w.usedPercent}% → ${s.after.find((a) => a.id === w.id)?.usedPercent ?? "—"}%`,
                  )
                  .join(" · ")}
              </Text>
              {!s.endedAt && s.observedAt ? (
                <Text>
                  {t("Last observation")}: {new Date(s.observedAt).toLocaleString()}
                </Text>
              ) : null}
              <Text>
                {s.excluded
                  ? t("Excluded: external activity")
                  : s.issues.length
                    ? s.issues
                        .map((issue) => t(subscriptionEstimationIssueLabels[issue] ?? issue))
                        .join(" · ")
                    : t("Observation only; external overlap remains possible")}
              </Text>
              {button(
                s.excluded ? "Restore sample" : "Exclude: used elsewhere during this interval",
                () => {
                  setBusy(true);
                  setError(false);
                  void exclude({ environmentId, input: { id: s.id, excluded: !s.excluded } })
                    .then((result) => {
                      if (result._tag === "Failure") setError(true);
                      else query.refresh();
                    })
                    .catch(() => setError(true))
                    .finally(() => setBusy(false));
                },
                busy || !s.endedAt,
              )}
            </View>
          ))
        : null}
      {report?.hasMore
        ? button("Older samples", () =>
            setBefore(
              report.samples.at(-1)
                ? { before: report.samples.at(-1)!.startedAt, beforeId: report.samples.at(-1)!.id }
                : undefined,
            ),
          )
        : null}
      {before ? button("Latest samples", () => setBefore(undefined)) : null}
    </View>
  );
}
