import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS desktop_channel_audit (
    request_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, host_name TEXT NOT NULL,
    server_cwd TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
    thread_id TEXT, provider TEXT, label TEXT, mode TEXT NOT NULL, summary TEXT NOT NULL,
    win_cwd TEXT, outcome TEXT NOT NULL, exit_code INTEGER, error_code TEXT, duration_ms INTEGER
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS desktop_channel_audit_started ON desktop_channel_audit(started_at DESC)`;
});
