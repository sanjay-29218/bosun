import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* A notice the person already heard about, whose reacting turn notifies nobody. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('notice_inbox')`;
  if (!columns.some((column) => column.name === "quiet")) {
    yield* sql`ALTER TABLE notice_inbox ADD COLUMN quiet INTEGER NOT NULL DEFAULT 0`;
  }
});
