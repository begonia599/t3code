import * as DateTime from "effect/DateTime";
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

// Providers jitter reset timestamps (Claude alternates 15:59:59 and 16:00:00), so
// equality would split one window into many single-sample cycles.
export const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const resetBucketMs = 5 * 60 * 1000;
const resetBucket = (resetsAt: string) =>
  Math.round(Date.parse(resetsAt) / resetBucketMs) * resetBucketMs;
export const subscriptionCycleId = (accountKey: string, windowId: string, resetsAt: string) =>
  `${accountKey}:${windowId}:${isoAt(resetBucket(resetsAt))}`;

/** Each account window is independent: session and weekly amounts never add. */
export function estimateSubscriptionCycles(
  samples: ReadonlyArray<SubscriptionEstimationSample>,
): SubscriptionEstimationCycle[] {
  const cycles = new Map<
    string,
    { -readonly [K in keyof SubscriptionEstimationCycle]: SubscriptionEstimationCycle[K] }
  >();
  const references = new Map<string, { cost: number; delta: number }>();
  // Used quota never falls inside one window except after a credit reset that keeps the
  // advertised reset time; start a new segment there instead of mixing two allowances.
  const segments = new Map<string, { generation: number; used: number }>();
  // A provider may reset a window early (Codex moved a weekly reset forward by days);
  // only the cycle seen by the newest task is live for each account window.
  const latestByWindow = new Map<string, string>();
  const partialIssues = new Set([
    "incompleteUsage",
    "backgroundUsageIncomplete",
    "pendingUsage",
    "unpriced",
  ]);
  for (const sample of [...samples].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    for (const before of sample.before) {
      if (!before.resetsAt || Date.parse(before.resetsAt) <= Date.parse(sample.startedAt)) continue;
      const base = subscriptionCycleId(sample.accountKey, before.id, before.resetsAt);
      const after = sample.after.find((w) => w.id === before.id);
      const sameWindow =
        !!after?.resetsAt && resetBucket(after.resetsAt) === resetBucket(before.resetsAt);
      const segment = segments.get(base) ?? { generation: 0, used: before.usedPercent };
      if (before.usedPercent < segment.used - 1) segment.generation++;
      segment.used =
        after && sameWindow ? Math.max(before.usedPercent, after.usedPercent) : before.usedPercent;
      segments.set(base, segment);
      const id = segment.generation ? `${base}#${segment.generation}` : base;
      const scope = scopeFor(before.id);
      const eligible =
        scope === "general" ||
        (scope !== "unsupported" &&
          sample.models.length > 0 &&
          sample.models.every((model) => model.toLowerCase().includes(scope)));
      const row = cycles.get(id) ?? {
        id,
        accountKey: sample.accountKey,
        windowId: before.id,
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
      // Keep the latest label and reset time; jittered resets must not reorder cards.
      row.label = sample.label;
      row.windowLabel = before.label;
      row.resetsAt = isoAt(Math.round(Date.parse(before.resetsAt) / 60_000) * 60_000);
      cycles.set(id, row);
      latestByWindow.set(`${sample.accountKey}\u0000${before.id}`, id);
    }
  }
  const live = new Set(latestByWindow.values());
  for (const [id, row] of cycles) {
    if (!live.has(id)) row.superseded = true;
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
