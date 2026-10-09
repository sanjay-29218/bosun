import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE features ADD COLUMN status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'closed'))`;
  yield* sql`ALTER TABLE features ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''`;
  yield* sql`UPDATE features SET updated_at = created_at`;
  yield* sql`ALTER TABLE features ADD COLUMN bot_assignments_json TEXT NOT NULL DEFAULT '{}'`;
});
