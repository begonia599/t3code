import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "desktop linked projects migration",
  (it) => {
    it.effect("upgrades from 56 once, preserves data and enforces host/path uniqueness", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 56 });
        yield* sql`INSERT INTO desktop_channel_audit (request_id,host_id,host_name,server_cwd,started_at,mode,summary,outcome) VALUES ('r','h','PC','/p','2026-01-01','argv','echo','running')`;
        assert.deepEqual(yield* runMigrations(), [[57, "DesktopLinkedProjects"]]);
        assert.equal((yield* sql`SELECT * FROM desktop_channel_audit`).length, 1);
        yield* sql`INSERT INTO desktop_linked_projects VALUES ('p','h','PC','C:\\p','c:\\p','/p','now','now')`;
        const duplicate =
          yield* sql`INSERT INTO desktop_linked_projects VALUES ('p2','h','PC','C:\\p','c:\\p','/p2','now','now')`.pipe(
            Effect.result,
          );
        assert.equal(duplicate._tag, "Failure");
        assert.deepEqual(yield* runMigrations(), []);
        assert.equal((yield* sql`SELECT * FROM desktop_linked_projects`).length, 1);
      }),
    );
  },
);
