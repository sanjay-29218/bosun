import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/* Todos kept in Bosun rather than on a repository host, numbered per project. */

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
      closed_reason TEXT CHECK (closed_reason IN ('completed', 'not_planned')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE (project_id, number)
    )
  `;
});
