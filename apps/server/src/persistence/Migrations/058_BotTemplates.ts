import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const previous = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bot_definitions'
  `;
  yield* sql`
    CREATE TABLE bot_templates (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      allowed_tools_json TEXT NOT NULL,
      model_selection_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      auto_create_for_feature INTEGER NOT NULL DEFAULT 0 CHECK (auto_create_for_feature IN (0, 1)),
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  if (previous.length > 0) {
    yield* sql`PRAGMA defer_foreign_keys = ON`;
    yield* sql`
      CREATE TABLE bots (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        feature_id TEXT,
        template_id TEXT REFERENCES bot_templates(id),
        template_revision INTEGER,
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
      INSERT INTO bots (
        id, project_id, feature_id, template_id, template_revision, name, instructions,
        allowed_tools_json, model_selection_json, runtime_mode, enabled,
        revision, created_at, updated_at
      )
      SELECT CASE
          WHEN id = 'bosun-captain' THEN 'bot-captain'
          WHEN id = 'bosun-manager:' || project_id THEN 'bot-manager:' || project_id
          WHEN id = 'bosun-execution:' || project_id THEN 'bot-builder:' || project_id
          ELSE id
        END,
        project_id, NULL, NULL, NULL,
        CASE WHEN id = 'bosun-execution:' || project_id THEN 'Builder' ELSE name END,
        REPLACE(REPLACE(instructions, 'bosun-execution:', 'bot-builder:'),
          'If Execution needs', 'If Builder needs'),
        allowed_tools_json, model_selection_json, runtime_mode, enabled,
        revision, created_at, updated_at
      FROM bot_definitions
    `;
    yield* sql`
      CREATE TABLE bot_runs_next (
        id TEXT PRIMARY KEY,
        bot_id TEXT NOT NULL REFERENCES bots(id),
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
      INSERT INTO bot_runs_next
      SELECT r.id,
        CASE
          WHEN r.bot_id = 'bosun-captain' THEN 'bot-captain'
          WHEN r.bot_id = 'bosun-manager:' || b.project_id THEN 'bot-manager:' || b.project_id
          WHEN r.bot_id = 'bosun-execution:' || b.project_id THEN 'bot-builder:' || b.project_id
          ELSE r.bot_id
        END,
        r.project_id, r.thread_id, r.task_text, r.title, r.instructions,
        r.allowed_tools_json, r.bot_revision, r.model_selection_json, r.runtime_mode,
        r.dispatch_state, r.recovery_attempt, r.last_error, r.created_at, r.dispatched_at
      FROM bot_runs AS r JOIN bot_definitions AS b ON b.id = r.bot_id
    `;
    yield* sql`
      CREATE TABLE bot_handoffs_next (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES bot_handoffs_next(id),
        source_run_id TEXT NOT NULL REFERENCES bot_runs_next(id),
        target_bot_id TEXT NOT NULL REFERENCES bots(id),
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
      INSERT INTO bot_handoffs_next
      SELECT h.id, h.parent_id, h.source_run_id,
        CASE
          WHEN h.target_bot_id = 'bosun-captain' THEN 'bot-captain'
          WHEN h.target_bot_id = 'bosun-manager:' || b.project_id THEN 'bot-manager:' || b.project_id
          WHEN h.target_bot_id = 'bosun-execution:' || b.project_id THEN 'bot-builder:' || b.project_id
          ELSE h.target_bot_id
        END,
        h.target_run_id, h.project_id, h.task_text, h.context_text, h.depth,
        h.status, h.response_text, h.question_text, h.last_error,
        h.notification_state, h.notice_version, h.attempt, h.created_at, h.updated_at
      FROM bot_handoffs AS h JOIN bot_definitions AS b ON b.id = h.target_bot_id
    `;
    yield* sql`DROP TABLE bot_handoffs`;
    yield* sql`DROP TABLE bot_runs`;
    yield* sql`DROP TABLE bot_definitions`;
    yield* sql`ALTER TABLE bot_runs_next RENAME TO bot_runs`;
    yield* sql`ALTER TABLE bot_handoffs_next RENAME TO bot_handoffs`;
    yield* sql`
      CREATE INDEX bot_runs_pending ON bot_runs (created_at, id)
      WHERE dispatch_state = 'queued'
    `;
    yield* sql`
      CREATE INDEX bot_runs_started ON bot_runs (id)
      WHERE dispatch_state = 'started'
    `;
    yield* sql`CREATE INDEX bot_handoffs_source ON bot_handoffs (source_run_id, created_at)`;
    yield* sql`CREATE INDEX bot_handoffs_pending ON bot_handoffs (status, created_at)`;
  }
  yield* sql`
    CREATE TABLE IF NOT EXISTS bot_delegation_grants (
      source_bot_id TEXT NOT NULL REFERENCES bots(id),
      target_bot_id TEXT NOT NULL REFERENCES bots(id),
      PRIMARY KEY (source_bot_id, target_bot_id),
      CHECK (source_bot_id <> target_bot_id)
    )
  `;
  // Preserve the authority of already-running default crews during the storage upgrade.
  yield* sql`
    INSERT OR IGNORE INTO bot_delegation_grants (source_bot_id, target_bot_id)
    SELECT captain.id, manager.id FROM bots AS captain
    JOIN bots AS manager ON manager.id = 'bot-manager:' || manager.project_id
    WHERE captain.id = 'bot-captain' AND manager.project_id IS NOT NULL
  `;
  yield* sql`
    INSERT OR IGNORE INTO bot_delegation_grants (source_bot_id, target_bot_id)
    SELECT manager.id, builder.id FROM bots AS manager
    JOIN bots AS builder ON builder.project_id = manager.project_id
      AND builder.id = 'bot-builder:' || builder.project_id
    WHERE manager.id = 'bot-manager:' || manager.project_id
  `;
});
