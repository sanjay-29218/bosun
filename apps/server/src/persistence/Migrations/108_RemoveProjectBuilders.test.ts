import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("removes each project's builder, keeping one a retired handoff names, turned off", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(107);
    yield* sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        enabled, auto_create_for_feature, revision, created_at, updated_at
      ) VALUES ('role:builder', 'Builder', 'Build.', '[]', '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', 1, 0, 1, '2026-11-01', '2026-11-01')
    `;
    const member = (id: string, project: string, instructions: string) => sql`
      INSERT INTO crew_members (
        id, project_id, role_id, role_revision, name, instructions, allowed_tools_json,
        model_selection_json, runtime_mode, enabled, revision, created_at, updated_at
      ) VALUES (${id}, ${project}, 'role:builder', 1, ${id}, ${instructions}, '[]',
        '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 1, 1, '2026-11-01', '2026-11-01')
    `;
    yield* member(
      "bot-manager:web",
      "web",
      "Lead.\n\nYou manage project web. Its builder is crew member bot-builder:web.",
    );
    yield* member("bot-builder:web", "web", "Build.\n\nYou work on project web.");
    yield* member("bot-builder:api", "api", "Build.\n\nYou work on project api.");
    yield* sql`
      INSERT INTO crew_delegation_grants (source_member_id, target_member_id)
      VALUES ('bot-manager:web', 'bot-builder:web')
    `;
    // Each member gets a hierarchy row as it is made; the builder sat under the manager.
    yield* sql`
      UPDATE crew_hierarchy SET parent_member_id = 'bot-manager:web'
      WHERE member_id = 'bot-builder:web'
    `;
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES ('run:api', 'bot-captain', 'api', 'bot-run:run:api', 'Task', 'Run', '', '[]', 1,
        '{}', 'full-access', '2026-11-01')
    `;
    // The retired handoff path once handed api's builder a request.
    yield* sql`
      INSERT INTO crew_handoffs (
        id, source_run_id, target_member_id, target_run_id, project_id, task_text, context_text,
        depth, status, created_at, updated_at
      ) VALUES ('handoff:1', 'run:api', 'bot-builder:api', 'run:api-builder', 'api', 'Build',
        '', 1, 'completed', '2026-11-01', '2026-11-01')
    `;

    yield* BosunMigrations.runMigrations(108);

    assert.deepStrictEqual(
      yield* sql`SELECT id, enabled, instructions FROM crew_members ORDER BY id`,
      [
        { id: "bot-builder:api", enabled: 0, instructions: "Build.\n\nYou work on project api." },
        { id: "bot-manager:web", enabled: 1, instructions: "Lead.\n\nYou manage project web." },
      ],
    );
    assert.deepStrictEqual(yield* sql`SELECT * FROM crew_delegation_grants`, []);
    assert.deepStrictEqual(
      yield* sql`SELECT member_id AS memberId, parent_member_id AS parent FROM crew_hierarchy`,
      [{ memberId: "bot-manager:web", parent: null }],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
