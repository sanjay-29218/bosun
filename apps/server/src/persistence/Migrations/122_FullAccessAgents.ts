import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Bots, roles, crew members and project managers all get every tool with full access, so the
 * withheld tools and access limits people saved are dropped. Standing runs (a headquarters, a
 * project's manager) took their owner's mode and go to full access; other runs keep theirs, the
 * mode their thread was started in, which a linked environment's access can narrow.
 */

const COLUMNS = {
  bots: ["withheld_tools_json", "runtime_mode"],
  roles: ["withheld_tools_json", "runtime_mode"],
  crew_members: ["withheld_tools_json", "runtime_mode"],
  crew_runs: ["withheld_tools_json"],
} as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const [table, columns] of Object.entries(COLUMNS)) {
    const present = new Set(
      (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`).map(
        (column) => column.name,
      ),
    );
    for (const column of columns) {
      if (present.has(column)) yield* sql`ALTER TABLE ${sql(table)} DROP COLUMN ${sql(column)}`;
    }
  }
  if (
    (yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'crew_runs'`).length
  ) {
    yield* sql`
      UPDATE crew_runs SET runtime_mode = 'full-access'
      WHERE id LIKE 'bot-hq:%' OR id LIKE 'project-hq:%'
    `;
  }
});
