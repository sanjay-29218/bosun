import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per stage attempt, keyed by the bot handoff that dispatched it.
  yield* sql`
    CREATE TABLE workflow_stage_handoffs (
      id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL REFERENCES feature_workflows(feature_id),
      step_id TEXT NOT NULL,
      execution_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      record_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX workflow_stage_handoffs_feature
    ON workflow_stage_handoffs (feature_id, created_at)
  `;
});
