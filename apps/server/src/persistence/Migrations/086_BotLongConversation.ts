import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* What a bot's headquarters does once its conversation grows long. Existing bots compact. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE bots
    ADD COLUMN long_conversation TEXT NOT NULL DEFAULT 'compact'
  `;
});
