import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const model = JSON.stringify({ instanceId: "codex", model: "gpt-5" });

it.effect("makes the Captain crew member the Captain bot that owns every project", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(70);

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at
      ) VALUES ('p1', 'One', '/tmp/one', '[]', '2026-10-01', '2026-10-01')
    `;
    const member = (id: string, projectId: string | null) => sql`
      INSERT INTO crew_members (
        id, project_id, name, instructions, allowed_tools_json, model_selection_json,
        runtime_mode, created_at, updated_at
      ) VALUES (${id}, ${projectId}, ${id}, ${`${id} instructions`}, '["crew.delegate"]',
        ${model}, 'auto', '2026-10-01', '2026-10-01')
    `;
    yield* member("bot-captain", null);
    yield* member("bot-manager:p1", "p1");
    yield* sql`
      INSERT INTO crew_delegation_grants (source_member_id, target_member_id)
      VALUES ('bot-captain', 'bot-manager:p1')
    `;
    yield* sql`
      UPDATE crew_hierarchy SET parent_member_id = 'bot-captain' WHERE member_id = 'bot-manager:p1'
    `;
    yield* sql`
      INSERT INTO crew_runs (
        id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at
      ) VALUES ('request', 'bot-captain', 'p1', 'bot-run:request', 'Do it', 'Captain', 'Lead',
        '["crew.delegate"]', 1, ${model}, 'auto', '2026-10-01')
    `;
    yield* sql`
      INSERT INTO crew_handoffs (
        id, source_run_id, target_member_id, target_run_id, project_id, task_text,
        context_text, depth, status, created_at, updated_at
      ) VALUES ('handoff', 'request', 'bot-manager:p1', 'bot-handoff:handoff', 'p1', 'Do it',
        '', 1, 'running', '2026-10-01', '2026-10-01')
    `;

    yield* runMigrations();

    // Captain keeps its instructions, tools, model and runtime mode as a bot (073 then adds
    // the grants a bot oversees its projects with, and 076 lets it manage workflows).
    assert.deepStrictEqual(
      yield* sql`
        SELECT id, name, instructions, allowed_tools_json AS tools,
          model_selection_json AS model, runtime_mode AS runtimeMode, position
        FROM bots
      `,
      [
        {
          id: "bot-captain",
          name: "Captain",
          instructions: "bot-captain instructions",
          tools: '["crew.delegate","crew.answer","crew.projects","crew.workflows"]',
          model,
          runtimeMode: "auto",
          position: 0,
        },
      ],
    );
    assert.deepStrictEqual(yield* sql`SELECT project_id, bot_id FROM projection_projects`, [
      { project_id: "p1", bot_id: "bot-captain" },
    ]);
    // Its runs and handoffs survive; its member row, grant and supervision do not.
    assert.deepStrictEqual(yield* sql`SELECT id FROM crew_members ORDER BY id`, [
      { id: "bot-manager:p1" },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT member_id FROM crew_runs`, [
      { member_id: "bot-captain" },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM crew_delegation_grants`, []);
    assert.deepStrictEqual(yield* sql`SELECT member_id, parent_member_id FROM crew_hierarchy`, [
      { member_id: "bot-manager:p1", parent_member_id: null },
    ]);
    assert.deepStrictEqual(yield* sql`SELECT status FROM crew_handoffs`, [{ status: "running" }]);
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("creates Captain without a model on a database that never set up a crew", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT id, model_selection_json AS model FROM bots`, [
      { id: "bot-captain", model: null },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
