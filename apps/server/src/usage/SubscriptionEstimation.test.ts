import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  EventId,
  type ProviderRuntimeEvent,
  type ServerProvider,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import * as Registry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as UsageService from "./UsageService.ts";
import * as Estimation from "./SubscriptionEstimation.ts";
import migrate from "../persistence/Migrations/055_SubscriptionEstimation.ts";

const instanceId = ProviderInstanceId.make("claudeAgent");
const tokens: TurnTokenUsage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: 100,
  outputTokens: 20,
  cachedInputTokens: 40,
  cacheCreationTokens: 10,
  reasoningTokens: 5,
  hasSubagents: false,
};
const setup = Effect.gen(function* () {
  yield* migrate;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM subscription_estimation_samples`;
  let used = 10;
  let email = "one@example.test";
  let reset = "2099-01-01T00:00:00.000Z";
  let refreshes = 0;
  let stale = false;
  let price = 0.01;
  const snapshot = (now: string): ServerProvider => ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "ready",
    auth: { status: "authenticated", email, type: "pro" },
    checkedAt: now,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: now,
      windows: [
        { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: used, resetsAt: reset },
      ],
    },
  });
  const current = Effect.map(DateTime.now, (date) =>
    snapshot(stale ? "1969-01-01T00:00:00.000Z" : DateTime.formatIso(date)),
  );
  const fake = {
    instanceId,
    snapshot: {
      getSnapshot: current,
      refresh: current.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            refreshes++;
          }),
        ),
      ),
    },
    invalidateCaches: Effect.void,
  } as unknown as ProviderInstance;
  const deps = Layer.mergeAll(
    Layer.mock(Registry.ProviderInstanceRegistry)({ getInstance: () => Effect.succeed(fake) }),
    Layer.mock(UsageService.UsageService)({
      quoteModel: () =>
        Effect.sync(() => ({
          rate: {
            inputCostPerToken: price,
            outputCostPerToken: 0.02,
            cacheReadCostPerToken: 0.001,
            cacheCreationCostPerToken: 0.012,
            fastMultiplier: 2,
          },
          pricing: {
            status: "fresh" as const,
            source: "test",
            fetchedAt: "1970-01-01T00:00:00.000Z",
            knownModels: 1,
          },
        })),
    }),
  );
  return {
    deps,
    setUsed: (n: number) => {
      used = n;
    },
    setEmail: (s: string) => {
      email = s;
    },
    setReset: (s: string) => {
      reset = s;
    },
    setStale: (value: boolean) => {
      stale = value;
    },
    setPrice: (value: number) => {
      price = value;
    },
    refreshes: () => refreshes,
  };
});
const storage = NodeSqliteClient.layer({ filename: ":memory:" });
it.layer(storage)("subscription observation storage", (it) => {
  it.effect("merges overlapping calls, samples only boundaries and retains exclusions", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* Estimation.SubscriptionEstimation;
        yield* service.begin({
          instanceId,
          runKey: "one",
          selection: { instanceId, model: "test-model" },
        });
        yield* service.begin({
          instanceId,
          runKey: "two",
          selection: { instanceId, model: "test-model" },
        });
        assert.equal(h.refreshes(), 1);
        yield* service.finish("one", tokens);
        assert.equal(h.refreshes(), 1);
        h.setUsed(14);
        yield* service.finish("two", tokens);
        yield* service.finish("two", tokens);
        assert.equal(h.refreshes(), 2);
        const report = yield* service.read();
        assert.equal(report.samples.length, 1);
        assert.equal(report.samples[0]?.calls, 2);
        assert.closeTo(report.samples[0]!.costUsd, 2.12, 0.00001);
        assert.deepEqual(report.samples[0]?.issues, []);
        yield* service.exclude(report.samples[0]!.id, true);
        assert.isTrue((yield* service.read()).samples[0]!.excluded);
        yield* service.exclude(report.samples[0]!.id, false);
        assert.isFalse((yield* service.read()).samples[0]!.excluded);
      }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
    }),
  );
  it.effect("never treats background or subagent missing usage as complete", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* Estimation.SubscriptionEstimation;
        yield* service.begin({ instanceId, runKey: "title", background: true });
        h.setUsed(15);
        yield* service.finish("title");
        const sample = (yield* service.read()).samples[0]!;
        assert.include(sample.issues, "backgroundUsageIncomplete");
        assert.include(sample.issues, "incompleteUsage");
        assert.isNull((yield* service.read()).cycles[0]!.estimatedTotalUsd);
      }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
    }),
  );
  it.effect("closes unfinished intervals as incomplete after restart", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      const program = Effect.gen(function* () {
        const service = yield* Estimation.SubscriptionEstimation;
        yield* service.begin({ instanceId, runKey: "crash" });
      });
      yield* program.pipe(
        Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))),
        Effect.scoped,
      );
      yield* Effect.gen(function* () {
        const service = yield* Estimation.SubscriptionEstimation;
        const report = yield* service.read();
        assert.include(report.samples[0]!.issues, "interrupted");
        assert.isNotNull(report.samples[0]!.endedAt);
      }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
      const sql = yield* SqlClient.SqlClient;
      assert.equal((yield* sql`SELECT * FROM subscription_estimation_samples`).length, 1);
    }),
  );
  it.effect(
    "separates reset cycles, credit resets and account changes without counting idle usage",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          const service = yield* Estimation.SubscriptionEstimation;
          const run = (end: number) =>
            Effect.gen(function* () {
              yield* service.begin({
                instanceId,
                runKey: "one",
                selection: { instanceId, model: "test-model" },
              });
              h.setUsed(end);
              yield* service.finish("one", tokens);
            });
          yield* run(12);
          h.setUsed(40); // Outside T3, between observation intervals.
          yield* run(42);
          yield* run(44);
          const first = (yield* service.read()).cycles[0]!;
          assert.equal(first.samples, 3);
          assert.equal(first.usedPercentagePoints, 6);
          assert.closeTo(first.estimatedTotalUsd!, 53, 0.0001);
          h.setReset("2099-01-08T00:00:00.000Z");
          h.setUsed(0);
          yield* run(2);
          let report = yield* service.read();
          assert.equal(report.cycles.length, 2);
          assert.isNull(report.cycles.find((c) => c.id !== first.id)!.estimatedTotalUsd);
          h.setUsed(0); // Manual credit reset even with an unchanged advertised reset date.
          yield* run(2);
          assert.equal((yield* service.read()).cycles.length, 3);
          h.setEmail("two@example.test");
          yield* run(4);
          report = yield* service.read();
          assert.equal(report.cycles.length, 4);
          assert.equal(new Set(report.samples.map((s) => s.accountKey)).size, 2);
          yield* service.begin({
            instanceId,
            runKey: "changed",
            selection: { instanceId, model: "test-model" },
          });
          h.setEmail("three@example.test");
          yield* service.finish("changed", tokens);
          assert.isTrue(
            (yield* service.read()).samples.some((s) => s.issues.includes("accountChanged")),
          );
        }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
      }),
  );
  it.effect(
    "freezes prices at start and refuses stale snapshots or incomplete subagent totals",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          const service = yield* Estimation.SubscriptionEstimation;
          yield* service.begin({
            instanceId,
            runKey: "priced",
            selection: { instanceId, model: "test-model" },
          });
          h.setPrice(100);
          h.setUsed(15);
          yield* service.finish("priced", tokens);
          assert.closeTo((yield* service.read()).samples[0]!.costUsd, 1.06, 0.00001);
          h.setStale(true);
          yield* service.begin({ instanceId, runKey: "stale" });
          yield* service.finish("stale", tokens);
          const samples = (yield* service.read()).samples;
          assert.isTrue(
            samples.some(
              (s) => s.issues.includes("missingBefore") && s.issues.includes("missingAfter"),
            ),
          );
          h.setStale(false);
          yield* service.begin({
            instanceId,
            runKey: "subagent",
            selection: { instanceId, model: "test-model" },
          });
          yield* service.finish("subagent", { ...tokens, hasSubagents: true });
          assert.isTrue(
            (yield* service.read()).samples.some((s) => s.issues.includes("incompleteUsage")),
          );
        }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
      }),
  );
  it.effect("does not reuse the old cycle key when quota resets during an interval", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* Estimation.SubscriptionEstimation;
        yield* service.begin({
          instanceId,
          runKey: "cross-reset",
          selection: { instanceId, model: "test-model" },
        });
        h.setReset("2099-01-08T00:00:00.000Z");
        h.setUsed(0);
        yield* service.finish("cross-reset", tokens);
        yield* service.begin({
          instanceId,
          runKey: "new-cycle",
          selection: { instanceId, model: "test-model" },
        });
        h.setUsed(2);
        yield* service.finish("new-cycle", tokens);
        const report = yield* service.read();
        assert.equal(report.cycles.length, 2);
        assert.deepEqual(report.cycles.map((c) => c.samples).toSorted(), [0, 1]);
      }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
    }),
  );
  it.effect(
    "matches instance and turn, ignores duplicate completions and closes exited sessions",
    () =>
      Effect.gen(function* () {
        const h = yield* setup;
        yield* Effect.gen(function* () {
          const service = yield* Estimation.SubscriptionEstimation;
          const threadId = ThreadId.make("thread");
          const base = {
            eventId: EventId.make("event"),
            threadId,
            turnId: TurnId.make("turn"),
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: instanceId,
            createdAt: "1970-01-01T00:00:00.000Z",
          };
          const event: ProviderRuntimeEvent = {
            ...base,
            type: "turn.completed",
            payload: { state: "completed", tokenUsage: tokens },
          };
          yield* service.begin({
            instanceId,
            runKey: `turn:${threadId}`,
            selection: { instanceId, model: "test-model" },
          });
          yield* service.bind(`turn:${threadId}`, "turn");
          yield* service.event({ ...event, providerInstanceId: ProviderInstanceId.make("other") });
          yield* service.event({ ...event, turnId: TurnId.make("old") });
          assert.isNull((yield* service.read()).samples[0]!.endedAt);
          h.setUsed(12);
          yield* service.event(event);
          yield* service.event(event);
          assert.closeTo((yield* service.read()).samples[0]!.costUsd, 1.06, 0.00001);
          yield* service.begin({ instanceId, runKey: `turn:${threadId}` });
          yield* service.event({ ...base, type: "session.exited", payload: {} });
          assert.isTrue((yield* service.read()).samples.every((s) => s.endedAt !== null));
        }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
      }),
  );
  it.effect("paginates tied timestamps without truncating a cycle's calibration", () =>
    Effect.gen(function* () {
      const h = yield* setup;
      yield* Effect.gen(function* () {
        const service = yield* Estimation.SubscriptionEstimation;
        for (let i = 0; i < 102; i++) {
          yield* service.begin({
            instanceId,
            runKey: "one",
            selection: { instanceId, model: "test-model" },
          });
          h.setUsed(10 + (i + 1) * 0.1);
          yield* service.finish("one", tokens);
        }
        const first = yield* service.read();
        assert.equal(first.samples.length, 100);
        assert.isTrue(first.hasMore);
        assert.equal(first.cycles[0]!.samples, 102);
        const last = first.samples.at(-1)!;
        const second = yield* service.read(last.startedAt, last.id);
        assert.equal(second.samples.length, 2);
        assert.isFalse(second.hasMore);
        assert.equal(second.cycles[0]!.samples, 102);
        assert.equal(new Set([...first.samples, ...second.samples].map((s) => s.id)).size, 102);
      }).pipe(Effect.provide(Estimation.layer.pipe(Layer.provide(h.deps))));
    }),
  );
});
