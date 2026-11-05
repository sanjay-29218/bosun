import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A linked environment's bot sends its workflow by value with a request. The request's run keeps
 * it, and a feature its project manager starts keeps its own copy, so it runs on that workflow
 * and its roles instead of the library here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS crew_run_workflows (
      run_id TEXT PRIMARY KEY,
      workflow_json TEXT NOT NULL
    )
  `;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('features')
  `;
  if (columns.length > 0 && !columns.some((column) => column.name === "workflow_snapshot_json")) {
    yield* sql`ALTER TABLE features ADD COLUMN workflow_snapshot_json TEXT`;
  }
});
