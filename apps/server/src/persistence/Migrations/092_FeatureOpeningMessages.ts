import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Earlier local builds added these message columns under migration 085.
  const featureColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(features)`;
  if (!featureColumns.some((column) => column.name === "brief_message_json")) {
    yield* sql`ALTER TABLE features ADD COLUMN brief_message_json TEXT`;
  }
  yield* sql`ALTER TABLE features ADD COLUMN brief_request_hash TEXT`;
  const runColumns = yield* sql<{ readonly name: string }>`PRAGMA table_info(crew_runs)`;
  if (!runColumns.some((column) => column.name === "opening_message_json")) {
    yield* sql`ALTER TABLE crew_runs ADD COLUMN opening_message_json TEXT`;
  }
});
