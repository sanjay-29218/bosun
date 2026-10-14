import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Top-level bots own projects. Captain is created from the old environment-wide Captain crew
 * member, keeping its instructions, tools and model, and owns every existing project. Bots
 * act in crew runs too, so runs no longer require their actor to be a crew member, and
 * Captain's delegation is derived from project ownership instead of stored grants.
 */

const CAPTAIN_BOT_ID = "bot-captain";
const CAPTAIN_INSTRUCTIONS =
  "You are Captain. Coordinate the person's project request. The task names its project manager. Delegate using crew_delegate with a stable request ID. Use crew_wait_handoff until the project manager reports a completed, failed, or needs-input outcome. Relay that outcome clearly to the person. Use crew_list_handoffs to recover state after a restart. Never claim work is done without a structured outcome.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  // crew_runs is rebuilt below; its handoffs reference it again once it is refilled.
  yield* sql`PRAGMA defer_foreign_keys = ON`;

  yield* sql`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      color TEXT NOT NULL,
      instructions TEXT NOT NULL,
      allowed_tools_json TEXT NOT NULL,
      runtime_mode TEXT NOT NULL CHECK (runtime_mode IN ('approval-required', 'auto-accept-edits', 'auto', 'full-access')),
      model_selection_json TEXT,
      default_workflow_id TEXT,
      position INTEGER NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      -- A deleted bot keeps its row so runs it started can still act and be read.
      deleted_at TEXT
    )
  `;
  const captain = tables.has("crew_members")
    ? yield* sql<{
        readonly instructions: string;
        readonly allowedToolsJson: string;
        readonly modelSelectionJson: string;
        readonly runtimeMode: string;
        readonly createdAt: string;
      }>`
        SELECT instructions, allowed_tools_json AS allowedToolsJson,
          model_selection_json AS modelSelectionJson, runtime_mode AS runtimeMode,
          created_at AS createdAt
        FROM crew_members WHERE id = ${CAPTAIN_BOT_ID}
      `
    : [];
  const now = DateTime.formatIso(yield* DateTime.now);
  const previous = captain[0];
  yield* sql`
    INSERT INTO bots (
      id, name, emoji, color, instructions, allowed_tools_json, runtime_mode,
      model_selection_json, default_workflow_id, position, revision, created_at, updated_at
    ) VALUES (
      ${CAPTAIN_BOT_ID}, 'Captain', '🧭', 'blue',
      ${previous?.instructions ?? CAPTAIN_INSTRUCTIONS},
      ${previous?.allowedToolsJson ?? '["crew.delegate","crew.status"]'},
      ${previous?.runtimeMode ?? "approval-required"}, ${previous?.modelSelectionJson ?? null},
      NULL, 0, 1, ${previous?.createdAt ?? now}, ${now}
    )
  `;

  // Projection rows replay `project.created` events without a bot as Captain's, too.
  yield* sql`
    ALTER TABLE projection_projects ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'bot-captain'
  `;

  if (tables.has("crew_runs")) {
    // Copy out, drop, recreate, then refill: refilling the recreated table is what lets the
    // deferred handoff references to it balance again before commit.
    yield* sql`CREATE TEMP TABLE crew_runs_copy AS SELECT * FROM crew_runs`;
    yield* sql`DROP TABLE crew_runs`;
    yield* sql`
      CREATE TABLE crew_runs (
        id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        thread_id TEXT NOT NULL UNIQUE,
        task_text TEXT NOT NULL,
        title TEXT NOT NULL,
        instructions TEXT NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        member_revision INTEGER NOT NULL,
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
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, dispatch_state,
        recovery_attempt, last_error, created_at, dispatched_at)
      SELECT id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, dispatch_state,
        recovery_attempt, last_error, created_at, dispatched_at
      FROM crew_runs_copy
    `;
    yield* sql`DROP TABLE crew_runs_copy`;
    yield* sql`
      CREATE INDEX crew_runs_pending ON crew_runs (created_at, id)
      WHERE dispatch_state = 'queued'
    `;
    yield* sql`CREATE INDEX crew_runs_started ON crew_runs (id) WHERE dispatch_state = 'started'`;
  }

  // Captain is a bot now. Its grants and place in the hierarchy follow from ownership.
  if (tables.has("crew_members")) {
    if (tables.has("crew_delegation_grants")) {
      yield* sql`
        DELETE FROM crew_delegation_grants
        WHERE source_member_id = ${CAPTAIN_BOT_ID} OR target_member_id = ${CAPTAIN_BOT_ID}
      `;
    }
    if (tables.has("crew_hierarchy")) {
      yield* sql`
        UPDATE crew_hierarchy SET parent_member_id = NULL
        WHERE parent_member_id = ${CAPTAIN_BOT_ID}
      `;
      yield* sql`DELETE FROM crew_hierarchy WHERE member_id = ${CAPTAIN_BOT_ID}`;
    }
    const targeted = tables.has("crew_handoffs")
      ? yield* sql`SELECT 1 FROM crew_handoffs WHERE target_member_id = ${CAPTAIN_BOT_ID} LIMIT 1`
      : [];
    // A handoff that once targeted Captain keeps its (disabled) member row as history.
    if (targeted.length === 0) {
      yield* sql`DELETE FROM crew_members WHERE id = ${CAPTAIN_BOT_ID}`;
    } else {
      yield* sql`UPDATE crew_members SET enabled = 0 WHERE id = ${CAPTAIN_BOT_ID}`;
    }
  }
});
