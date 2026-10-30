import * as NodeCrypto from "node:crypto";
import {
  SubscriptionEstimationError,
  SubscriptionEstimationSample,
  type SubscriptionEstimationReport,
  type ProviderInstanceId,
  type ModelSelection,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as UsageService from "./UsageService.ts";
import { type ModelRate, priceUsage } from "./usagePricing.ts";
import { estimateSubscriptionCycles } from "./subscriptionEstimationMath.ts";

type BeginInput = {
  instanceId: ProviderInstanceId;
  runKey: string;
  selection?: ModelSelection;
  background?: boolean;
};
type PendingItem = {
  instanceId: ProviderInstanceId;
  model: string;
  rate: ModelRate | null;
  fast: boolean;
  turnId?: string;
};
type Group = {
  sample: SubscriptionEstimationSample;
  pending: Map<string, PendingItem>;
  instanceId: ProviderInstanceId;
};
export class SubscriptionEstimation extends Context.Service<
  SubscriptionEstimation,
  {
    readonly begin: (input: BeginInput) => Effect.Effect<void>;
    readonly bind: (runKey: string, turnId: string) => Effect.Effect<void>;
    readonly finish: (runKey: string, usage?: TurnTokenUsage) => Effect.Effect<void>;
    readonly event: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly read: (
      before?: string,
      beforeId?: string,
    ) => Effect.Effect<SubscriptionEstimationReport, SubscriptionEstimationError>;
    readonly exclude: (
      id: string,
      excluded: boolean,
    ) => Effect.Effect<void, SubscriptionEstimationError>;
  }
>()("t3/usage/SubscriptionEstimation") {}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decode = Schema.decodeSync(Schema.fromJsonString(SubscriptionEstimationSample));
const identity = (provider: ServerProvider) => {
  const account =
    provider.auth.email?.trim().toLowerCase() || provider.usageLimits?.credentialFingerprint;
  return {
    known: Boolean(account),
    key: NodeCrypto.createHash("sha256")
      .update(
        encodeJson([
          provider.driver,
          account || provider.instanceId,
          provider.auth.type,
          provider.auth.label,
        ]),
      )
      .digest("hex"),
  };
};
const withIssue = (
  s: SubscriptionEstimationSample,
  issue: string,
): SubscriptionEstimationSample => ({ ...s, issues: [...new Set([...s.issues, issue])] });
const fail = () =>
  new SubscriptionEstimationError({
    detail: "Subscription estimation records could not be read or saved.",
  });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const pricing = yield* UsageService.UsageService;
  const lock = yield* Semaphore.make(1);
  const groups = new Map<string, Group>();
  const runs = new Map<string, Group>();
  const persist = (s: SubscriptionEstimationSample) => sql`
    INSERT INTO subscription_estimation_samples (id, account_key, started_at, ended_at, payload_json)
    VALUES (${s.id}, ${s.accountKey}, ${s.startedAt}, ${s.endedAt}, ${encodeJson(s)})
    ON CONFLICT(id) DO UPDATE SET ended_at=excluded.ended_at, payload_json=excluded.payload_json`;
  // Never join an unfinished pre-restart interval to a new execution.
  const interrupted = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM subscription_estimation_samples WHERE ended_at IS NULL`;
  for (const row of interrupted) {
    const sample = decode(row.payload_json);
    yield* persist({ ...withIssue(sample, "interrupted"), endedAt: yield* nowIso });
  }
  const safe = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.ignoreCause({ log: true }));
  const fresh = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const instance = yield* registry.getInstance(instanceId);
      if (!instance) return undefined;
      const started = yield* Clock.currentTimeMillis;
      yield* instance.invalidateCaches ?? Effect.void;
      const snapshot = yield* instance.snapshot.refresh;
      if (
        snapshot.auth.status !== "authenticated" ||
        !snapshot.usageLimits ||
        snapshot.usageLimits.unavailable ||
        Date.parse(snapshot.usageLimits.checkedAt) < started - 1000
      )
        return undefined;
      return snapshot;
    }).pipe(
      Effect.timeout("12 seconds"),
      Effect.orElseSucceed(() => undefined),
    );

  const begin = (input: BeginInput) =>
    safe(
      lock.withPermit(
        Effect.gen(function* () {
          const existing = runs.get(input.runKey);
          if (existing) {
            existing.sample = withIssue(existing.sample, "overlappingThread");
            yield* persist(existing.sample);
            return;
          }
          const instance = yield* registry.getInstance(input.instanceId);
          if (!instance) return;
          const current = yield* instance.snapshot.getSnapshot;
          if (!current.enabled || current.auth.status !== "authenticated") return;
          // API-key/unsupported providers have no subscription window to estimate.
          if (current.usageLimits?.unavailable?.reason === "unsupported") return;
          const model = input.selection?.model ?? "unknown";
          const quote = yield* pricing.quoteModel(model).pipe(
            Effect.timeout("5 seconds"),
            Effect.orElseSucceed(() => null),
          );
          let key = identity(current).key;
          let group = groups.get(key);
          if (!group) {
            const snapshot = yield* fresh(input.instanceId);
            const account = identity(snapshot ?? current);
            key = account.key;
            group = groups.get(key);
            if (!group) {
              const now = yield* nowIso;
              const previousRows = yield* sql<{
                payload_json: string;
              }>`SELECT payload_json FROM subscription_estimation_samples WHERE account_key=${key} ORDER BY started_at DESC, rowid DESC LIMIT 1`;
              const previous = previousRows[0] ? decode(previousRows[0].payload_json) : undefined;
              const before = snapshot?.usageLimits?.windows ?? [];
              const cycleKeys: Record<string, string> = {};
              for (const window of before) {
                if (!window.resetsAt || Date.parse(window.resetsAt) <= Date.parse(now)) continue;
                const last = previous?.after.find((w) => w.id === window.id);
                const start = previous?.before.find((w) => w.id === window.id);
                cycleKeys[window.id] =
                  start?.resetsAt === window.resetsAt &&
                  last?.resetsAt === window.resetsAt &&
                  last.usedPercent >= start.usedPercent &&
                  window.usedPercent >= last.usedPercent &&
                  !previous?.issues.includes("accountChanged") &&
                  previous?.cycleKeys[window.id]
                    ? previous.cycleKeys[window.id]!
                    : NodeCrypto.randomUUID();
              }
              const sample: SubscriptionEstimationSample = {
                id: NodeCrypto.randomUUID(),
                accountKey: key,
                label: current.displayName ?? String(input.instanceId),
                driver: current.driver,
                startedAt: now,
                endedAt: null,
                before,
                after: [],
                cycleKeys,
                costUsd: 0,
                calls: 0,
                models: [],
                priceSources: [],
                excluded: false,
                issues: [
                  ...(!snapshot || before.length === 0 ? ["missingBefore"] : []),
                  ...(!account.known ? ["unknownAccount"] : []),
                ],
              };
              group = { sample, pending: new Map(), instanceId: input.instanceId };
              groups.set(key, group);
            }
          }
          group.sample = {
            ...group.sample,
            calls: group.sample.calls + 1,
            models: [...new Set([...group.sample.models, model])],
            priceSources: [
              ...new Set([
                ...group.sample.priceSources,
                encodeJson({
                  model,
                  rate: quote?.rate,
                  source: quote?.pricing.source,
                  at: quote?.pricing.fetchedAt,
                }),
              ]),
            ],
          };
          if (input.background) group.sample = withIssue(group.sample, "backgroundUsageIncomplete");
          group.pending.set(input.runKey, {
            instanceId: input.instanceId,
            model,
            rate: quote?.rate ?? null,
            fast:
              input.selection?.options?.some((o) => o.id === "fastMode" && o.value === true) ??
              false,
          });
          runs.set(input.runKey, group);
          yield* persist(group.sample);
        }),
      ),
    );

  const finish = (runKey: string, usage?: TurnTokenUsage) =>
    safe(
      lock.withPermit(
        Effect.gen(function* () {
          const group = runs.get(runKey);
          const item = group?.pending.get(runKey);
          if (!group || !item) return;
          runs.delete(runKey);
          group.pending.delete(runKey);
          if (!usage || usage.usageStatus !== "complete" || usage.hasSubagents)
            group.sample = withIssue(group.sample, "incompleteUsage");
          if (!item.rate) group.sample = withIssue(group.sample, "unpriced");
          if (usage?.inputTokens !== undefined && usage.outputTokens !== undefined && item.rate) {
            const cached = usage.cachedInputTokens ?? 0;
            const created = usage.cacheCreationTokens ?? 0;
            if (cached + created > usage.inputTokens)
              group.sample = withIssue(group.sample, "invalidTokens");
            else {
              const cost = priceUsage(
                new Map([[item.model, item.rate]]),
                {
                  model: item.model,
                  fast: item.fast,
                  reportedCostUsd: null,
                  totals: {
                    uncachedInputTokens: usage.inputTokens - cached - created,
                    cachedInputTokens: cached,
                    cacheCreationTokens: created,
                    outputTokens: usage.outputTokens,
                    reasoningTokens: usage.reasoningTokens ?? 0,
                  },
                },
                new Map([[item.model, item.rate]]),
              );
              group.sample = { ...group.sample, costUsd: group.sample.costUsd + cost.costUsd };
            }
          }
          if (group.pending.size === 0) {
            const snapshot = yield* fresh(group.instanceId);
            group.sample = {
              ...group.sample,
              endedAt: yield* nowIso,
              after: snapshot?.usageLimits?.windows ?? [],
            };
            if (!snapshot) group.sample = withIssue(group.sample, "missingAfter");
            else if (identity(snapshot).key !== group.sample.accountKey)
              group.sample = withIssue(group.sample, "accountChanged");
            if (Object.keys(group.sample.cycleKeys).length === 0)
              group.sample = withIssue(group.sample, "unknownCycle");
            groups.delete(group.sample.accountKey);
          }
          yield* persist(group.sample);
        }),
      ),
    );
  const bind = (runKey: string, turnId: string) =>
    Effect.sync(() => {
      const item = runs.get(runKey)?.pending.get(runKey);
      if (item) item.turnId = turnId;
    });
  const event = (e: ProviderRuntimeEvent) => {
    const key = `turn:${e.threadId}`;
    const group = runs.get(key);
    const item = group?.pending.get(key);
    if (item && e.providerInstanceId && item.instanceId !== e.providerInstanceId)
      return Effect.void;
    if (group && Date.parse(e.createdAt) < Date.parse(group.sample.startedAt)) return Effect.void;
    if (e.type === "turn.started" && !item)
      return safe(
        lock.withPermit(
          Effect.gen(function* () {
            for (const active of groups.values()) {
              if (
                [...active.pending.values()].some(
                  (call) => call.instanceId === e.providerInstanceId,
                )
              ) {
                active.sample = withIssue(active.sample, "untrackedActivity");
                yield* persist(active.sample);
              }
            }
          }),
        ),
      );
    if (e.type === "turn.started" && item && e.turnId && !item.turnId) return bind(key, e.turnId);
    if (item?.turnId && e.turnId && item.turnId !== e.turnId) return Effect.void;
    if (e.type === "turn.completed") return finish(key, e.payload.tokenUsage);
    if (e.type === "turn.aborted")
      return finish(
        key,
        e.payload.tokenUsage ? { ...e.payload.tokenUsage, usageStatus: "partial" } : undefined,
      );
    if (e.type === "session.exited") return finish(key);
    if (e.type === "model.rerouted")
      return safe(
        lock.withPermit(
          Effect.gen(function* () {
            const group = runs.get(key);
            if (group) {
              group.sample = withIssue(group.sample, "modelChanged");
              yield* persist(group.sample);
            }
          }),
        ),
      );
    return Effect.void;
  };
  const read = (before?: string, beforeId?: string) =>
    Effect.gen(function* () {
      // Limit the response, never delete source observations. Pagination retains old cycles.
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM subscription_estimation_samples WHERE started_at < ${before ?? "9999"} OR (started_at = ${before ?? "9999"} AND id < ${beforeId ?? ""}) ORDER BY started_at DESC, id DESC LIMIT 101`;
      const samples = rows.slice(0, 100).map((row) => decode(row.payload_json));
      const ids = [...new Set(samples.flatMap((sample) => Object.values(sample.cycleKeys)))];
      const cycleRows = ids.length
        ? yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM subscription_estimation_samples WHERE EXISTS (SELECT 1 FROM json_each(payload_json, '$.cycleKeys') cycle WHERE ${sql.in("cycle.value", ids)})`
        : [];
      return {
        cycles: estimateSubscriptionCycles(cycleRows.map((row) => decode(row.payload_json))),
        samples,
        hasMore: rows.length > 100,
      };
    }).pipe(Effect.catchCause(() => fail()));
  const exclude = (id: string, excluded: boolean) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const rows = yield* sql<{
            payload_json: string;
          }>`SELECT payload_json FROM subscription_estimation_samples WHERE id=${id}`;
          if (!rows[0]) return yield* fail();
          const sample = { ...decode(rows[0].payload_json), excluded };
          yield* persist(sample);
          const active = groups.get(sample.accountKey);
          if (active?.sample.id === id) active.sample = sample;
        }),
      )
      .pipe(Effect.catchCause(() => fail()));
  return { begin, bind, finish, event, read, exclude };
});
export const layer = Layer.effect(SubscriptionEstimation, make);
