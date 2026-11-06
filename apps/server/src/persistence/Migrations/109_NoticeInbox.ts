import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Notices held for a busy thread, delivered as one digest when it is free. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS notice_inbox (
      thread_id TEXT NOT NULL,
      key TEXT NOT NULL,
      subject TEXT,
      text TEXT NOT NULL,
      summary TEXT,
      outcome TEXT,
      source_thread_id TEXT,
      request_id TEXT,
      created_at TEXT NOT NULL,
      digest_id TEXT,
      delivered_at TEXT,
      dropped_at TEXT,
      PRIMARY KEY (thread_id, key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS notice_inbox_pending_idx ON notice_inbox (thread_id)
    WHERE delivered_at IS NULL AND dropped_at IS NULL
  `;
});
