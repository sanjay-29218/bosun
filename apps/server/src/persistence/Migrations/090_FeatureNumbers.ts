import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* Features get a number per project, like tickets, so one without an issue still has a name. */

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE features ADD COLUMN number INTEGER`;
  yield* sql`
    UPDATE features SET number = (
      SELECT COUNT(*) FROM features earlier
      WHERE earlier.project_id = features.project_id
        AND (earlier.created_at < features.created_at
          OR (earlier.created_at = features.created_at AND earlier.id <= features.id))
    )
  `;
  yield* sql`CREATE UNIQUE INDEX features_project_number ON features (project_id, number)`;
});
