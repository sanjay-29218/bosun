import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A crew run can name a worktree its thread makes as it starts, from this base ref. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('crew_runs')`;
  if (columns.length === 0 || columns.some((column) => column.name === "base_ref")) return;
  yield* sql`ALTER TABLE crew_runs ADD COLUMN base_ref TEXT`;
});
