import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A project's manager lives on one environment. A copy whose manager lives elsewhere names it
 * (`remote_manager_json`); the home copy lists where its manager may work, null following its
 * bot. Existing projects keep their manager here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* sql`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projection_projects'
  `;
  if (projects.length === 0) return;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN remote_manager_json TEXT`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN manager_permitted_environment_ids_json TEXT`;
});
