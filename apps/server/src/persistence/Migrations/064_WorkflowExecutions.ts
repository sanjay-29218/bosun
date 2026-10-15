import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workflow_executions (
      feature_id TEXT PRIMARY KEY REFERENCES feature_workflows(feature_id),
      bindings_json TEXT NOT NULL,
      last_error TEXT,
      settled INTEGER NOT NULL DEFAULT 0 CHECK (settled IN (0, 1))
    )
  `;
  yield* sql`
    CREATE INDEX workflow_step_events_handoff
    ON workflow_step_events (json_extract(event_json, '$.sourceId'))
    WHERE json_extract(event_json, '$.kind') = 'started'
  `;
});
