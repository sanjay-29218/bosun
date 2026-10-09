import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bosun_bot_handoffs (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES bosun_bot_handoffs(id),
      source_run_id TEXT NOT NULL REFERENCES bosun_bot_runs(id),
      target_bot_id TEXT NOT NULL REFERENCES bosun_bot_definitions(id),
      target_run_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      task_text TEXT NOT NULL,
      context_text TEXT NOT NULL,
      depth INTEGER NOT NULL CHECK (depth BETWEEN 1 AND 8),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'needs-input', 'failed', 'cancelled')),
      response_text TEXT,
      question_text TEXT,
      last_error TEXT,
      notification_state TEXT NOT NULL DEFAULT 'none' CHECK (notification_state IN ('none', 'queued', 'delivered')),
      notice_version INTEGER NOT NULL DEFAULT 0,
      attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt BETWEEN 1 AND 10),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX bosun_bot_handoffs_source ON bosun_bot_handoffs (source_run_id, created_at)
  `;
  yield* sql`
    CREATE INDEX bosun_bot_handoffs_pending ON bosun_bot_handoffs (status, created_at)
  `;
});
