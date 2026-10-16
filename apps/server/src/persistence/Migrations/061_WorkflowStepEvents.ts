import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE feature_workflows
    ADD COLUMN event_version INTEGER NOT NULL DEFAULT 0 CHECK (event_version >= 0)
  `;
  yield* sql`
    CREATE TABLE workflow_step_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      feature_id TEXT NOT NULL REFERENCES feature_workflows(feature_id),
      event_id TEXT NOT NULL,
      event_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      UNIQUE (feature_id, event_id)
    )
  `;
  yield* sql`
    CREATE INDEX workflow_step_events_feature
    ON workflow_step_events (feature_id, sequence)
  `;
});
