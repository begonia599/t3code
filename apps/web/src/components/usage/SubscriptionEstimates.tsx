import { useState } from "react";
import { subscriptionEstimationIssueLabels, type EnvironmentId } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useT } from "../../i18n";
import { formatUsd } from "@t3tools/shared/usageFormat";

export function SubscriptionEstimates({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const t = useT();
  const [before, setBefore] = useState<{ before: string; beforeId: string } | undefined>();
  const query = useEnvironmentQuery(
    serverEnvironment.subscriptionEstimation({ environmentId, input: before ?? {} }),
  );
  const exclude = useAtomCommand(serverEnvironment.excludeSubscriptionSample);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const report = query.data;
  return (
    <section className="my-5 grid gap-3 rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">
          {t("Subscription API-equivalent estimates")} · {label}
        </h2>
        <Button size="sm" variant="outline" onClick={query.refresh}>
          {t("Refresh")}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          "Only T3 activity is recorded. Concurrent use elsewhere cannot be ruled out. Estimates depend on the observed model mix, not an official balance.",
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        {t(
          "Estimates need 3 complete samples covering at least 5 percentage points. Reference API rates are saved when each task starts; incomplete usage is excluded from calibration.",
        )}
      </p>
      {query.error || error ? (
        <p role="alert">{t("Could not update subscription estimates.")}</p>
      ) : null}
      {!report ? (
        <p>{t("Loading…")}</p>
      ) : (
        <>
          {report.cycles.length === 0 ? (
            <p>{t("Collecting samples. New tasks record quota before and after execution.")}</p>
          ) : null}
          {report.cycles.map((cycle) => (
            <div key={cycle.id} className="grid gap-1 rounded-lg bg-muted/40 p-3 text-sm">
              <strong>
                {cycle.label} · {cycle.windowLabel} · {new Date(cycle.resetsAt).toLocaleString()}
              </strong>
              <span>
                {t("T3 recorded API equivalent")}: {formatUsd(cycle.observedCostUsd)}
              </span>
              <span>
                {t("Valid samples / quota coverage")}: {cycle.samples} /{" "}
                {cycle.usedPercentagePoints.toFixed(2)}%
              </span>
              <span>
                {t("Estimated full cycle")}:{" "}
                {cycle.estimatedTotalUsd === null
                  ? t(
                      cycle.scope === "unsupported"
                        ? "Quota scope is not supported for calibration"
                        : "Collecting samples",
                    )
                  : formatUsd(cycle.estimatedTotalUsd)}
              </span>
              <span>
                {t("Estimated remaining at last observation")}:{" "}
                {cycle.estimatedRemainingUsd === null
                  ? "—"
                  : formatUsd(cycle.estimatedRemainingUsd)}
              </span>
            </div>
          ))}
          <details>
            <summary className="cursor-pointer text-sm">
              {t("Sample records and external activity")} ({report.samples.length})
            </summary>
            <div className="mt-3 grid gap-3">
              {report.samples.map((sample) => (
                <div key={sample.id} className="grid gap-1 border-t border-border py-2 text-xs">
                  <span>
                    {sample.label} · {new Date(sample.startedAt).toLocaleString()} →{" "}
                    {sample.endedAt ? new Date(sample.endedAt).toLocaleString() : t("Running")}
                  </span>
                  <span>
                    {sample.models.join(", ")} · {formatUsd(sample.costUsd)} · {sample.calls}{" "}
                    {t("calls")}
                  </span>
                  <span>
                    {sample.before
                      .map(
                        (w) =>
                          `${w.label}: ${w.usedPercent}% → ${sample.after.find((a) => a.id === w.id)?.usedPercent ?? "—"}%`,
                      )
                      .join(" · ")}
                  </span>
                  <span>
                    {sample.excluded
                      ? t("Excluded: external activity")
                      : sample.issues.length
                        ? sample.issues
                            .map((issue) => t(subscriptionEstimationIssueLabels[issue] ?? issue))
                            .join(" · ")
                        : t("Observation only; external overlap remains possible")}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending !== null || !sample.endedAt}
                    onClick={async () => {
                      setPending(sample.id);
                      setError(false);
                      try {
                        const result = await exclude({
                          environmentId,
                          input: { id: sample.id, excluded: !sample.excluded },
                        });
                        if (result._tag === "Failure") setError(true);
                        else query.refresh();
                      } catch {
                        setError(true);
                      } finally {
                        setPending(null);
                      }
                    }}
                  >
                    {sample.excluded
                      ? t("Restore sample")
                      : t("Exclude: used elsewhere during this interval")}
                  </Button>
                </div>
              ))}
            </div>
          </details>
          <div className="flex gap-2">
            {report.hasMore ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setBefore(
                    report.samples.at(-1)
                      ? {
                          before: report.samples.at(-1)!.startedAt,
                          beforeId: report.samples.at(-1)!.id,
                        }
                      : undefined,
                  )
                }
              >
                {t("Older samples")}
              </Button>
            ) : null}
            {before ? (
              <Button size="sm" variant="ghost" onClick={() => setBefore(undefined)}>
                {t("Latest samples")}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
