import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* An automation can run as its project's manager, and records why the server paused one. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('scheduled_tasks')`;
  if (!columns.some((column) => column.name === "project_manager")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN project_manager INTEGER NOT NULL DEFAULT 0`;
  }
  if (!columns.some((column) => column.name === "paused_reason")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN paused_reason TEXT`;
  }
});
