import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A bot moving to another machine records where and under which ID until the move finishes, and
 * a copy made from another machine's bot records which one, so only that move can undo it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const bots = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bots'`;
  if (bots.length === 0) return;
  // Dev databases ran this as an earlier migration; the columns are added once.
  const present = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(bots)`).map((column) => column.name),
  );
  if (!present.has("moving_json")) yield* sql`ALTER TABLE bots ADD COLUMN moving_json TEXT`;
  if (!present.has("copied_from_json")) {
    yield* sql`ALTER TABLE bots ADD COLUMN copied_from_json TEXT`;
  }
});
