import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Merged pull requests whose linked issues were closed, so a reopened issue stays open. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS merge_closed_issues (
      project_id TEXT NOT NULL,
      pull_request_key TEXT NOT NULL,
      closed_at TEXT NOT NULL,
      PRIMARY KEY (project_id, pull_request_key)
    )
  `;
});
