import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Requests a bot sends a project's manager, and the manager turns that took them. A request's
 * result arrives turns later, so who asked is stored rather than read from a turn. Features and
 * tasks name the request they answer.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_requests (
      project_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      id TEXT NOT NULL,
      requester_thread_id TEXT NOT NULL,
      send_key TEXT NOT NULL,
      text TEXT NOT NULL,
      issue_ref TEXT,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
      delivered_at TEXT,
      created_at TEXT NOT NULL,
      closed_at TEXT,
      PRIMARY KEY (project_id, number),
      UNIQUE (project_id, id),
      UNIQUE (requester_thread_id, send_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS project_requests_undelivered ON project_requests (project_id)
    WHERE delivered_at IS NULL
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS project_request_turns (
      project_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      replied INTEGER NOT NULL DEFAULT 0 CHECK (replied IN (0, 1)),
      fallback_sent INTEGER NOT NULL DEFAULT 0 CHECK (fallback_sent IN (0, 1)),
      PRIMARY KEY (project_id, request_id, run_id)
    )
  `;
  const features = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('features')`;
  if (features.length > 0 && !features.some((column) => column.name === "request_id")) {
    yield* sql`ALTER TABLE features ADD COLUMN request_id TEXT`;
  }
});
