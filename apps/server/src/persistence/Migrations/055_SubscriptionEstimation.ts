import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS subscription_estimation_samples (
    id TEXT PRIMARY KEY, account_key TEXT NOT NULL, started_at TEXT NOT NULL,
    ended_at TEXT, payload_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS subscription_estimation_account ON subscription_estimation_samples(account_key, started_at)`;
});
