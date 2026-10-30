import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

export const SubscriptionEstimationSample = Schema.Struct({
  id: TrimmedNonEmptyString,
  accountKey: TrimmedNonEmptyString,
  label: Schema.String,
  driver: ProviderDriverKind,
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  before: Schema.Array(ServerProviderUsageWindow),
  after: Schema.Array(ServerProviderUsageWindow),
  cycleKeys: Schema.Record(Schema.String, Schema.String),
  costUsd: Schema.Number,
  calls: Schema.Number,
  issues: Schema.Array(Schema.String),
  excluded: Schema.Boolean,
  models: Schema.Array(Schema.String),
  priceSources: Schema.Array(Schema.String),
});
export type SubscriptionEstimationSample = typeof SubscriptionEstimationSample.Type;
export const SubscriptionEstimationCycle = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  windowLabel: Schema.String,
  scope: Schema.String,
  resetsAt: IsoDateTime,
  samples: Schema.Number,
  observedCostUsd: Schema.Number,
  calibrationCostUsd: Schema.Number,
  usedPercentagePoints: Schema.Number,
  remainingPercent: Schema.Number,
  estimatedTotalUsd: Schema.NullOr(Schema.Number),
  estimatedRemainingUsd: Schema.NullOr(Schema.Number),
});
export type SubscriptionEstimationCycle = typeof SubscriptionEstimationCycle.Type;
export const SubscriptionEstimationReport = Schema.Struct({
  cycles: Schema.Array(SubscriptionEstimationCycle),
  samples: Schema.Array(SubscriptionEstimationSample),
  hasMore: Schema.Boolean,
});
export type SubscriptionEstimationReport = typeof SubscriptionEstimationReport.Type;
export const SubscriptionEstimationReadInput = Schema.Struct({
  before: Schema.optional(IsoDateTime),
  beforeId: Schema.optional(TrimmedNonEmptyString),
});
export const SubscriptionEstimationExcludeInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  excluded: Schema.Boolean,
});
export class SubscriptionEstimationError extends Schema.TaggedError<SubscriptionEstimationError>()(
  "SubscriptionEstimationError",
  { detail: Schema.String },
) {
  override get message() {
    return this.detail;
  }
}

export const subscriptionEstimationIssueLabels: Readonly<Record<string, string>> = {
  overlappingThread: "Overlapping requests in one thread could not be separated",
  untrackedActivity: "Untracked agent activity overlapped this interval",
  interrupted: "Execution was interrupted; snapshots are incomplete",
  missingBefore: "Fresh starting quota is unavailable",
  missingAfter: "Fresh ending quota is unavailable",
  unknownAccount: "Account identity is unavailable",
  backgroundUsageIncomplete: "Background usage is incomplete",
  incompleteUsage: "Token or subagent usage is incomplete",
  unpriced: "Model price is unavailable",
  invalidTokens: "Token counts are inconsistent",
  accountChanged: "Account changed during execution",
  unknownCycle: "Reset cycle is unavailable",
  modelChanged: "Model changed during execution",
};
