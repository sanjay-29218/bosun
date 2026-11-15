import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Workflows shared with linked environments. The owner keeps a row per environment it shares a
 * workflow with (`workflow_shares`), until a removal reaches it. A copy there, and each role that
 * came with one, names the environment it is managed from (`managed_by_json`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflow_shares (
      workflow_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      label TEXT NOT NULL,
      shared INTEGER NOT NULL DEFAULT 1,
      role_choices_json TEXT NOT NULL DEFAULT '{}',
      pushed_digest TEXT,
      synced_at TEXT,
      clashes_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      PRIMARY KEY (workflow_id, environment_id)
    )
  `;
  yield* sql`ALTER TABLE workflows ADD COLUMN managed_by_json TEXT`;
  yield* sql`ALTER TABLE roles ADD COLUMN managed_by_json TEXT`;
});
