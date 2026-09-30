import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_handoff_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      handoff_id TEXT NOT NULL REFERENCES bot_handoffs(id),
      handoff_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX bot_handoff_receipts_handoff ON bot_handoff_receipts(handoff_id, sequence)`;
});
