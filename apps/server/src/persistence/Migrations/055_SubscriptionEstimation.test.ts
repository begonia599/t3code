import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("subscription schema upgrade", (it) => {
  it.effect("preserves existing conversations and runs the new migration once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
      VALUES ('existing', 'project', 'Existing conversation', '{"instanceId":"codex","model":"test"}', 'full-access', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
      assert.deepEqual(yield* runMigrations(), [[55, "SubscriptionEstimation"]]);
      assert.equal(
        (yield* sql`SELECT * FROM projection_threads WHERE thread_id='existing'`).length,
        1,
      );
      assert.equal((yield* sql`SELECT * FROM subscription_estimation_samples`).length, 0);
      assert.deepEqual(yield* runMigrations(), []);
    }),
  );
});
