import type { SubscriptionEstimationCycle, SubscriptionEstimationSample } from "@t3tools/contracts";

const generalWindows = new Set([
  "primary",
  "secondary",
  "five_hour",
  "seven_day",
  "weekly",
  "monthly",
  "subscription",
  "rolling",
  "session",
]);
function scopeFor(id: string): string {
  if (generalWindows.has(id)) return "general";
  for (const model of ["opus", "sonnet", "fable", "haiku"])
    if (id === `seven_day_${model}`) return model;
  return "unsupported";
}

/** Each account window is independent: session and weekly amounts never add. */
export function estimateSubscriptionCycles(
  samples: ReadonlyArray<SubscriptionEstimationSample>,
): SubscriptionEstimationCycle[] {
  const cycles = new Map<
    string,
    { -readonly [K in keyof SubscriptionEstimationCycle]: SubscriptionEstimationCycle[K] }
  >();
  for (const sample of [...samples].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    for (const before of sample.before) {
      const id = sample.cycleKeys[before.id];
      if (!id || !before.resetsAt) continue;
      const after = sample.after.find((w) => w.id === before.id);
      const scope = scopeFor(before.id);
      const eligible =
        scope === "general" ||
        (scope !== "unsupported" &&
          sample.models.length > 0 &&
          sample.models.every((model) => model.toLowerCase().includes(scope)));
      const row = cycles.get(id) ?? {
        id,
        label: sample.label,
        windowLabel: before.label,
        scope,
        resetsAt: before.resetsAt,
        samples: 0,
        observedCostUsd: 0,
        calibrationCostUsd: 0,
        usedPercentagePoints: 0,
        remainingPercent: 100 - before.usedPercent,
        estimatedTotalUsd: null,
        estimatedRemainingUsd: null,
      };
      if (eligible) row.observedCostUsd += sample.costUsd;
      row.remainingPercent = Math.min(row.remainingPercent, 100 - before.usedPercent);
      const sameWindow = after?.resetsAt === before.resetsAt;
      if (after && sameWindow && after.usedPercent >= before.usedPercent)
        row.remainingPercent = Math.min(row.remainingPercent, 100 - after.usedPercent);
      const delta = after ? after.usedPercent - before.usedPercent : -1;
      if (
        eligible &&
        sample.costUsd > 0 &&
        sample.endedAt &&
        !sample.excluded &&
        sample.issues.length === 0 &&
        sameWindow &&
        delta >= 0 &&
        Date.parse(sample.endedAt) < Date.parse(before.resetsAt)
      ) {
        row.samples++;
        row.calibrationCostUsd += sample.costUsd;
        row.usedPercentagePoints += delta;
      }
      // Small/rounded deltas are observations, not enough evidence for a balance.
      if (row.samples >= 3 && row.usedPercentagePoints >= 5 && row.calibrationCostUsd > 0) {
        row.estimatedTotalUsd = (row.calibrationCostUsd * 100) / row.usedPercentagePoints;
        row.estimatedRemainingUsd = (row.estimatedTotalUsd * row.remainingPercent) / 100;
      }
      cycles.set(id, row);
    }
  }
  return [...cycles.values()].toReversed();
}
