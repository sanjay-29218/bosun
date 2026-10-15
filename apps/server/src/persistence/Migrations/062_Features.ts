import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE features (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (length(id) > 0)
    )
  `;
  yield* sql`
    CREATE INDEX features_project ON features (project_id, created_at, id)
  `;
});
