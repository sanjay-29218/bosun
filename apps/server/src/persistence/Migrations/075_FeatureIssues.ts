import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* A feature can link the issue it works on: a FeatureIssue as JSON, as it read when linked. */

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE features ADD COLUMN issue_json TEXT`;
});
