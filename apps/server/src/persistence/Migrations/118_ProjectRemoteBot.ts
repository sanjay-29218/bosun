import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A project's owner can be a bot on another environment, kept as JSON beside `bot_id`, which
 * stays a bot here. Existing projects keep their owner and have no remote one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_projects'
  `;
  if (projects.length === 0) return;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN remote_bot_json TEXT`;
});
