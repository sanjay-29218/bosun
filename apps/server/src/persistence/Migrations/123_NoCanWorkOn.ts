import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Every bot and project manager works on every linked environment, so the global link list is
 * the only control. The Can work on lists bots and managers saved are dropped.
 */

const COLUMNS = {
  bots: "permitted_environment_ids_json",
  projection_projects: "manager_permitted_environment_ids_json",
} as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, column] of Object.entries(COLUMNS)) {
    const present = yield* sql<{ name: string }>`
      SELECT name FROM pragma_table_info(${table}) WHERE name = ${column}
    `;
    if (present.length > 0) yield* sql`ALTER TABLE ${sql(table)} DROP COLUMN ${sql(column)}`;
  }
});
