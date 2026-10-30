import { describe, expect, it } from "vitest";
import { ProviderDriverKind, type SubscriptionEstimationSample } from "@t3tools/contracts";
import { estimateSubscriptionCycles } from "./subscriptionEstimationMath.ts";
const reset = "2099-01-08T00:00:00.000Z";
const sample = (
  n: number,
  patch: Partial<SubscriptionEstimationSample> = {},
): SubscriptionEstimationSample => ({
  id: String(n),
  accountKey: "account",
  label: "Claude",
  driver: ProviderDriverKind.make("claudeAgent"),
  startedAt: `2099-01-01T00:0${n}:00.000Z`,
  endedAt: `2099-01-01T00:0${n}:30.000Z`,
  before: [
    { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 20 + n * 2, resetsAt: reset },
  ],
  after: [
    { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 22 + n * 2, resetsAt: reset },
  ],
  cycleKeys: { weekly: "week-1" },
  costUsd: 0.4,
  calls: 1,
  issues: [],
  excluded: false,
  models: ["model"],
  priceSources: [],
  ...patch,
});
describe("subscription estimates", () => {
  it("uses summed cost / quota deltas, excluding activity between intervals", () => {
    const samples = [
      sample(0),
      sample(1),
      sample(2, {
        before: [{ ...sample(2).before[0]!, usedPercent: 60 }],
        after: [{ ...sample(2).after[0]!, usedPercent: 62 }],
      }),
    ];
    const [cycle] = estimateSubscriptionCycles(samples);
    expect(cycle?.estimatedTotalUsd).toBeCloseTo(20);
    expect(cycle?.estimatedRemainingUsd).toBeCloseTo(7.6);
    expect(cycle?.usedPercentagePoints).toBe(6);
  });
  it("does not extrapolate tiny or zero deltas", () => {
    const samples = [0, 1, 2].map((n) => sample(n, { after: sample(n).before }));
    expect(estimateSubscriptionCycles(samples)[0]?.estimatedTotalUsd).toBeNull();
  });
  it("keeps observed costs when externally contaminated samples are excluded", () => {
    const samples = [sample(0), sample(1), sample(2, { excluded: true })];
    const [cycle] = estimateSubscriptionCycles(samples);
    expect(cycle?.observedCostUsd).toBeCloseTo(1.2);
    expect(cycle?.calibrationCostUsd).toBeCloseTo(0.8);
    expect(cycle?.estimatedTotalUsd).toBeNull();
    expect(
      estimateSubscriptionCycles([sample(0), sample(1), sample(2)])[0]?.estimatedTotalUsd,
    ).toBeCloseTo(20);
  });
  it("does not carry calibration into a new cycle or another quota window", () => {
    const samples = [
      sample(0),
      sample(1),
      sample(2),
      sample(3, { cycleKeys: { weekly: "week-2" } }),
    ];
    expect(
      estimateSubscriptionCycles(samples).find((c) => c.id === "week-2")?.estimatedTotalUsd,
    ).toBeNull();
    expect(estimateSubscriptionCycles(samples).find((c) => c.id === "week-1")?.samples).toBe(3);
  });
  it("rejects missing ends, incomplete usage, resets and negative quota deltas", () => {
    const bad = [
      sample(0, { endedAt: null }),
      sample(1, { issues: ["incompleteUsage"] }),
      sample(2, { after: [{ ...sample(2).after[0]!, resetsAt: "2099-01-15T00:00:00.000Z" }] }),
      sample(3, { after: [{ ...sample(3).after[0]!, usedPercent: 0 }] }),
    ];
    expect(estimateSubscriptionCycles(bad)[0]?.samples).toBe(0);
  });
  it("never charges mixed-model or unknown scopes against a model-specific allowance", () => {
    const scoped = [0, 1, 2].map((n) =>
      sample(n, {
        models: ["claude-opus-4-6"],
        before: [{ ...sample(n).before[0]!, id: "seven_day_sonnet" }],
        after: [{ ...sample(n).after[0]!, id: "seven_day_sonnet" }],
        cycleKeys: { seven_day_sonnet: "sonnet" },
      }),
    );
    expect(estimateSubscriptionCycles(scoped)[0]?.samples).toBe(0);
    const sonnet = scoped.map((s) => ({ ...s, models: ["claude-sonnet-4-6"] }));
    expect(estimateSubscriptionCycles(sonnet)[0]?.estimatedTotalUsd).toBeCloseTo(20);
    expect(
      estimateSubscriptionCycles(
        sonnet.map((s) => ({ ...s, models: ["claude-sonnet-4-6", "claude-opus-4-6"] })),
      )[0]?.samples,
    ).toBe(0);
  });
});
