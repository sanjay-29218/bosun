import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Workflows and roles copied to every linked machine. A copy is an ordinary row naming the
 * machine it is managed from. The owner keeps what each machine last got of each one, and a
 * hash of the whole set it last took, so it only sends a machine what changed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["roles", "workflows"] as const) {
    const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
    if (columns.length > 0 && !columns.some((column) => column.name === "managed_from_json")) {
      yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN managed_from_json TEXT`;
    }
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS library_copies (
      environment_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      delivered_revision INTEGER,
      delivered_at TEXT,
      problem TEXT,
      PRIMARY KEY (environment_id, kind, item_id)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS library_copy_peers (
      environment_id TEXT PRIMARY KEY,
      delivered_hash TEXT NOT NULL,
      delivered_at TEXT NOT NULL
    )
  `;
});
