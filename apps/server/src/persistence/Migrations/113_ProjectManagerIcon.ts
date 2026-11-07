import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* The bot look a person chose for a project's manager; null shows one derived from the project. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('crew_members')`;
  if (columns.length === 0 || columns.some((column) => column.name === "icon_json")) return;
  yield* sql`ALTER TABLE crew_members ADD COLUMN icon_json TEXT`;
});
