import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* An automation can run as a bot, in its headquarters. Null keeps a task running as a thread. */

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN bot_id TEXT`;
});
