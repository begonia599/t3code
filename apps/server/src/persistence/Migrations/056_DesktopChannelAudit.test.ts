import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "desktop channel audit migration",
  (it) => {
    it.effect("preserves existing state and upgrades exactly once", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 55 });
        yield* sql`INSERT INTO subscription_estimation_samples (id, account_key, started_at, payload_json) VALUES ('old', 'account', '2026-01-01', '{}')`;
        assert.deepEqual(yield* runMigrations(), [[56, "DesktopChannelAudit"]]);
        assert.equal(
          (yield* sql`SELECT * FROM subscription_estimation_samples WHERE id='old'`).length,
          1,
        );
        yield* sql`INSERT INTO desktop_channel_audit (request_id,host_id,host_name,server_cwd,started_at,mode,summary,outcome) VALUES ('r','h','Windows','/project','2026-01-01','argv','echo','running')`;
        assert.equal((yield* sql`SELECT * FROM desktop_channel_audit`).length, 1);
        assert.deepEqual(yield* runMigrations(), []);
      }),
    );
  },
);
