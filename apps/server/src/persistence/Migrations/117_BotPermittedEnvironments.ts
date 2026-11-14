import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Linked environments each bot may start new work on. Existing bots get every environment linked
 * today, keeping the reach they had before the choice existed.
 */
const idsJson = (rows: ReadonlyArray<{ readonly id: string }>) =>
  JSON.stringify(rows.map((row) => row.id));

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (table: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  if (!(yield* hasTable("bots"))) return;
  yield* sql`
    ALTER TABLE bots ADD COLUMN permitted_environment_ids_json TEXT NOT NULL DEFAULT '[]'
  `;
  if (!(yield* hasTable("peer_environment_links"))) return;
  const linked = yield* sql<{ readonly id: string }>`
    SELECT environment_id AS id FROM peer_environment_links ORDER BY environment_id
  `;
  yield* sql`
    UPDATE bots SET permitted_environment_ids_json = ${idsJson(linked)}
  `;
});
