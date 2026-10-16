import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A feature waiting for a stage slot, and the provider instance whose slot it holds.
  yield* sql`ALTER TABLE workflow_executions ADD COLUMN queued_at TEXT`;
  yield* sql`ALTER TABLE workflow_executions ADD COLUMN slot_instance_id TEXT`;
  // A Retry with another model, applied when the queued handoff starts its run.
  // Feature-only databases reached slot 62 without Bots' slots 55-59, so they have no handoffs table.
  const handoffs = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_handoffs'
  `;
  if (handoffs.length > 0) {
    yield* sql`ALTER TABLE bot_handoffs ADD COLUMN model_selection_json TEXT`;
  }
  // The board summary for each stage thread, read with thread shells.
  yield* sql`
    CREATE TABLE crew_stage_threads (
      thread_id TEXT PRIMARY KEY,
      feature_id TEXT NOT NULL,
      summary_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX crew_stage_threads_feature ON crew_stage_threads (feature_id)`;
});
