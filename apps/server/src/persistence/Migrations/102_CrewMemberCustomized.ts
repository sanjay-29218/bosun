import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Project-level members follow their role's edits. `customized_at` marks one whose settings
 * someone saved in its project, which role edits then leave alone.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('crew_members')`;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "customized_at")) {
    yield* sql`ALTER TABLE crew_members ADD COLUMN customized_at TEXT`;
  }
});
