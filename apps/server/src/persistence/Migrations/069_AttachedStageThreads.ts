import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Every provider run update looks up whether its thread is an attached stage thread.
  yield* sql`
    CREATE INDEX workflow_step_events_attached_thread
    ON workflow_step_events (json_extract(event_json, '$.threadId'))
    WHERE json_extract(event_json, '$.kind') = 'attached'
  `;
});
