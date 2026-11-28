import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Copies become editable imports at an unknown source revision (the first sync compares content),
 * and the machine that copied them keeps who holds them as importers. Roles and crew members gain
 * a fallback model. `managed_from_json` stays unused; dropping columns isn't worth the risk.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columnsOf = (table: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );
  const addColumn = Effect.fn(function* (table: string, column: string) {
    const columns = yield* columnsOf(table);
    if (columns.size > 0 && !columns.has(column)) {
      yield* sql`ALTER TABLE ${sql(table)} ADD COLUMN ${sql(column)} TEXT`;
    }
  });
  yield* addColumn("roles", "imported_from_json");
  yield* addColumn("roles", "fallback_model_selection_json");
  yield* addColumn("workflows", "imported_from_json");
  yield* addColumn("crew_members", "fallback_model_selection_json");

  for (const table of ["roles", "workflows"] as const) {
    if (!(yield* columnsOf(table)).has("managed_from_json")) continue;
    yield* sql`
      UPDATE ${sql(table)} SET
        imported_from_json = json_object(
          'environmentId', json_extract(managed_from_json, '$.environmentId'),
          'label', json_extract(managed_from_json, '$.label'),
          'revision', NULL,
          'localRevision', revision,
          'available', NULL,
          'skipped', NULL,
          'problem', NULL
        ),
        managed_from_json = NULL
      WHERE managed_from_json IS NOT NULL
    `;
  }

  yield* sql`
    CREATE TABLE IF NOT EXISTS library_importers (
      environment_id TEXT NOT NULL,
      label TEXT NOT NULL,
      kind TEXT NOT NULL,
      item_id TEXT NOT NULL,
      revision INTEGER,
      edited INTEGER NOT NULL DEFAULT 0,
      push_revision INTEGER,
      push_overwrites INTEGER NOT NULL DEFAULT 0,
      seen_at TEXT NOT NULL,
      PRIMARY KEY (environment_id, kind, item_id)
    )
  `;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  if (tables.has("library_copies")) {
    // A machine that refused a copy never held it.
    const label = tables.has("peer_environment_links")
      ? sql`COALESCE(
          (SELECT p.label FROM peer_environment_links p WHERE p.environment_id = c.environment_id),
          c.environment_id
        )`
      : sql`c.environment_id`;
    yield* sql`
      INSERT OR IGNORE INTO library_importers
        (environment_id, label, kind, item_id, revision, edited, seen_at)
      SELECT c.environment_id, ${label}, c.kind, c.item_id, c.delivered_revision, 0,
        COALESCE(c.delivered_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      FROM library_copies c
      WHERE c.problem IS NULL AND c.delivered_revision IS NOT NULL
    `;
    yield* sql`DROP TABLE library_copies`;
  }
  yield* sql`DROP TABLE IF EXISTS library_copy_peers`;
});
