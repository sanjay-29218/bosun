import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The merged pull requests each project's manager has been told about, one per project. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_merge_notices (
      project_id TEXT NOT NULL,
      pull_request_key TEXT NOT NULL,
      notified_at TEXT NOT NULL,
      PRIMARY KEY (project_id, pull_request_key)
    )
  `;
});
