import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A feature's last report says how its lead reported (finished, or a quiet "stopped" note) and
 * during which lead run, so a later run isn't covered by an earlier report and clients can
 * tell finished work from a lead that merely stopped.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('features')`;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "report_outcome")) {
    yield* sql`ALTER TABLE features ADD COLUMN report_outcome TEXT`;
  }
  if (!columns.some((column) => column.name === "reported_run_id")) {
    yield* sql`ALTER TABLE features ADD COLUMN reported_run_id TEXT`;
  }
});
