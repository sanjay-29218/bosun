import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A feature can move to another workflow once, from Quick task. Its history before the move
 * stays in workflow_step_events; the workflow reads only the events from this sequence on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE feature_workflows
    ADD COLUMN events_from_sequence INTEGER NOT NULL DEFAULT 0
  `;
});
