import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A bot's headquarters and a project's manager always let the provider compact a long
 * conversation; a person starts a fresh session with /new. The saved setting is dropped.
 */

const TABLES = ["bots", "crew_members"] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of TABLES) {
    const present = yield* sql<{ name: string }>`
      SELECT name FROM pragma_table_info(${table}) WHERE name = 'long_conversation'
    `;
    if (present.length > 0) yield* sql`ALTER TABLE ${sql(table)} DROP COLUMN long_conversation`;
  }
});
