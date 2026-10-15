import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE workflow_executions ADD COLUMN feature_context TEXT NOT NULL DEFAULT ''`;
  yield* sql`CREATE TABLE feature_launches (
    feature_id TEXT PRIMARY KEY REFERENCES features(id),
    project_id TEXT NOT NULL,
    source_run_id TEXT NOT NULL REFERENCES bot_runs(id),
    actor_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('pending', 'attached', 'cancelled')),
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX feature_launches_pending ON feature_launches (phase, feature_id)`;
});
