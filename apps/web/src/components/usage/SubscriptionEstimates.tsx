import { useState } from "react";
import {
  subscriptionEstimationIssueLabels,
  type EnvironmentId,
  type SubscriptionEstimationCycle,
  type SubscriptionEstimationSample,
} from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { useT } from "../../i18n";
import { formatUsd } from "@t3tools/shared/usageFormat";

const shortDate = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

// Short windows first so each account reads "session, then weekly".
const windowOrder = (id: string | undefined) =>
  id === "five_hour" || id === "session" || id === "primary" ? 0 : 1;
const byAccountThenWindow = (a: SubscriptionEstimationCycle, b: SubscriptionEstimationCycle) =>
  a.label.localeCompare(b.label) ||
  windowOrder(a.windowId) - windowOrder(b.windowId) ||
  a.resetsAt.localeCompare(b.resetsAt);

function CycleCard({ cycle }: { cycle: SubscriptionEstimationCycle }) {
  const t = useT();
  const used = Math.round(100 - cycle.remainingPercent);
  const estimated = cycle.estimatedTotalUsd !== null;
  const lowerBound = !estimated && cycle.knownCostTotalUsd != null;
  return (
    <div className="grid gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">
          {cycle.label} · {t(cycle.windowLabel)}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t("Used")} {used}%
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">
          {estimated
            ? `≈ ${formatUsd(cycle.estimatedTotalUsd!)}`
            : lowerBound
              ? `≥ ${formatUsd(cycle.knownCostTotalUsd!)}`
              : "—"}
        </span>
        <span className="text-xs text-muted-foreground">{t("per cycle")}</span>
        {estimated && cycle.preliminary ? (
          <span className="rounded bg-warning-surface px-1.5 py-0.5 text-xs text-warning-foreground">
            {t("Preliminary")}
          </span>
        ) : null}
      </div>
      <div className="text-xs text-muted-foreground">
        {estimated
          ? `${t("Left:")} ≈ ${formatUsd(cycle.estimatedRemainingUsd ?? 0)} · `
          : lowerBound
            ? `${t("Some task usage was incomplete; this is a lower bound")} · `
            : ""}
        {t("Resets")} {shortDate(cycle.resetsAt)}
      </div>
      <div className="text-xs text-muted-foreground">
        {estimated || lowerBound
          ? `${t("Based on")} ${cycle.samples} ${t("tasks")} · ${formatUsd(cycle.calibrationCostUsd || cycle.observedCostUsd)} · ${t("quota moved")} ${Math.round(estimated ? cycle.usedPercentagePoints : (cycle.knownCostPercentagePoints ?? 0))} ${t("points")}`
          : cycle.scope === "unsupported"
            ? t("This quota window cannot be estimated")
            : `${t("Recorded")} ${formatUsd(cycle.observedCostUsd)} · ${t("quota has not moved measurably yet")}`}
      </div>
    </div>
  );
}

function SampleRow({
  sample,
  disabled,
  onToggle,
}: {
  sample: SubscriptionEstimationSample;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  const changes = sample.before
    .map(
      (w) =>
        `${t(w.label)} ${w.usedPercent}→${sample.after.find((a) => a.id === w.id)?.usedPercent ?? "?"}%`,
    )
    .join(" · ");
  const note = sample.excluded
    ? t("Excluded")
    : sample.issues
        .map((issue) => t(subscriptionEstimationIssueLabels[issue] ?? issue))
        .join(" · ");
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border py-2 text-xs">
      <div className="grid min-w-0 gap-0.5">
        <span>
          {sample.label} · {shortDate(sample.startedAt)}
          {sample.endedAt ? "" : ` · ${t("Running")}`} · {formatUsd(sample.costUsd)}
          {changes ? ` · ${changes}` : ""}
        </span>
        <span className="truncate text-muted-foreground">
          {sample.models.join(", ")}
          {note ? ` · ${note}` : ""}
        </span>
      </div>
      <Button
        size="xs"
        variant="ghost"
        disabled={disabled || !sample.endedAt}
        title={t("Exclude when this account was also used outside T3 during the task")}
        onClick={onToggle}
      >
        {sample.excluded ? t("Restore sample") : t("Exclude")}
      </Button>
    </div>
  );
}

export function SubscriptionEstimates({
  environmentId,
  label,
  showLabel = true,
}: {
  environmentId: EnvironmentId;
  label: string;
  showLabel?: boolean;
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
  // Captured once per mount; cards re-split on refresh, which remounts query data.
  const [now] = useState(() => Date.now());
  const cycles = [...(report?.cycles ?? [])].toSorted(byAccountThenWindow);
  const current = cycles.filter((c) => Date.parse(c.resetsAt) > now);
  const past = cycles
    .filter((c) => Date.parse(c.resetsAt) <= now)
    .toSorted((a, b) => b.resetsAt.localeCompare(a.resetsAt));
  const toggle = async (sample: SubscriptionEstimationSample) => {
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
  };
  return (
    <section className="mt-8 grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="grid gap-0.5">
          <h2 className="font-medium">
            {t("Subscription value estimate")}
            {showLabel ? ` · ${label}` : ""}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t(
              "T3 token costs ÷ quota used in the same tasks ≈ what each window is worth at API prices. Use outside T3 is not seen; for reference only.",
            )}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={query.refresh}>
          {t("Refresh")}
        </Button>
      </div>
      {query.error || error ? (
        <p role="alert" className="text-sm text-destructive">
          {t("Could not update subscription estimates.")}
        </p>
      ) : null}
      {!report ? (
        <p className="text-sm text-muted-foreground">{t("Loading…")}</p>
      ) : (
        <>
          {current.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("No data yet. Each T3 task records quota before and after it runs.")}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {current.map((cycle) => (
                <CycleCard key={cycle.id} cycle={cycle} />
              ))}
            </div>
          )}
          {past.length > 0 ? (
            <details>
              <summary className="cursor-pointer text-sm text-muted-foreground">
                {t("Past cycles")} ({past.length})
              </summary>
              <div className="mt-2 grid gap-1 text-xs">
                {past.map((cycle) => (
                  <div
                    key={cycle.id}
                    className="flex justify-between gap-3 border-t border-border py-1.5"
                  >
                    <span>
                      {cycle.label} · {t(cycle.windowLabel)} · {t("Reset")}{" "}
                      {shortDate(cycle.resetsAt)}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      {cycle.estimatedTotalUsd === null
                        ? "—"
                        : `≈ ${formatUsd(cycle.estimatedTotalUsd)}`}{" "}
                      · {cycle.samples} {t("tasks")}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          ) : null}
          <details>
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t("Task records")} ({report.samples.length})
            </summary>
            <div className="mt-2 grid">
              {report.samples.map((sample) => (
                <SampleRow
                  key={sample.id}
                  sample={sample}
                  disabled={pending !== null}
                  onToggle={() => void toggle(sample)}
                />
              ))}
              <div className="flex gap-2 pt-2">
                {report.hasMore ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const last = report.samples.at(-1);
                      setBefore(last ? { before: last.startedAt, beforeId: last.id } : undefined);
                    }}
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
            </div>
          </details>
        </>
      )}
    </section>
  );
}
