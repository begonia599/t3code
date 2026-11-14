import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS desktop_linked_projects (
    project_id TEXT PRIMARY KEY, host_id TEXT NOT NULL, host_name TEXT NOT NULL,
    win_path TEXT NOT NULL, win_path_key TEXT NOT NULL, server_path TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS desktop_linked_projects_host_path ON desktop_linked_projects(host_id, win_path_key)`;
});
