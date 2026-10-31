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
  const references = new Map<string, { cost: number; delta: number }>();
  const partialIssues = new Set([
    "incompleteUsage",
    "backgroundUsageIncomplete",
    "pendingUsage",
    "unpriced",
  ]);
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
      const observedEnd = sample.endedAt ?? sample.observedAt;
      if (
        eligible &&
        sample.costUsd > 0 &&
        observedEnd &&
        !sample.excluded &&
        sameWindow &&
        delta >= 0 &&
        Date.parse(observedEnd) < Date.parse(before.resetsAt)
      ) {
        if (sample.issues.length === 0) {
          row.samples++;
          row.calibrationCostUsd += sample.costUsd;
          row.usedPercentagePoints += delta;
          if (!sample.endedAt) row.preliminary = true;
        }
        if (sample.issues.every((issue) => partialIssues.has(issue))) {
          const reference = references.get(id) ?? { cost: 0, delta: 0 };
          reference.cost += sample.costUsd;
          reference.delta += delta;
          references.set(id, reference);
        }
      }
      cycles.set(id, row);
    }
  }
  for (const [id, row] of cycles) {
    // Show useful early evidence, explicitly provisional, instead of hiding a
    // multi-hour task until three entire turns finish. Zero deltas still divide by nothing.
    if (row.usedPercentagePoints >= 1 && row.calibrationCostUsd > 0) {
      row.estimatedTotalUsd = (row.calibrationCostUsd * 100) / row.usedPercentagePoints;
      row.estimatedRemainingUsd = (row.estimatedTotalUsd * row.remainingPercent) / 100;
      row.preliminary ||= row.samples < 3 || row.usedPercentagePoints < 5;
    }
    const reference = references.get(id);
    if (reference && reference.delta >= 1 && reference.cost > 0) {
      // This is deliberately separate from a full-cost estimate: missing child
      // usage must never be silently priced as zero or charged at the parent's rate.
      row.knownCostTotalUsd = (reference.cost * 100) / reference.delta;
      row.knownCostRemainingUsd = (row.knownCostTotalUsd * row.remainingPercent) / 100;
      row.knownCostPercentagePoints = reference.delta;
    }
  }
  return [...cycles.values()].toReversed();
}
