import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bosun_bot_definitions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      role TEXT NOT NULL CHECK (role IN ('captain', 'manager', 'planner', 'designer', 'execution', 'reviewer')),
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      allowed_tools_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE bosun_bot_runs (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bosun_bot_definitions(id),
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      task_text TEXT NOT NULL,
      title TEXT NOT NULL,
      instructions TEXT NOT NULL,
      allowed_tools_json TEXT NOT NULL,
      bot_revision INTEGER NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL,
      dispatch_state TEXT NOT NULL DEFAULT 'queued' CHECK (dispatch_state IN ('queued', 'started')),
      recovery_attempt INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX bosun_bot_runs_pending ON bosun_bot_runs (created_at, id)
    WHERE dispatch_state = 'queued'
  `;
  yield* sql`
    CREATE INDEX bosun_bot_runs_started ON bosun_bot_runs (id)
    WHERE dispatch_state = 'started'
  `;
});
