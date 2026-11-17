import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const columnsOf = (table: string) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`),
    Effect.map((rows) => rows.map((row) => row.name)),
  );

it.effect("drops saved withheld tools and access limits, keeping each agent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(121);
    const model = '{"instanceId":"codex","model":"gpt-5"}';
    yield* sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, withheld_tools_json, runtime_mode, position,
        created_at, updated_at
      ) VALUES ('captain', 'Captain', '{}', 'blue', '', '["crew.workflows","preview"]',
        'approval-required', 1, '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO roles (
        id, name, instructions, withheld_tools_json, model_selection_json, runtime_mode,
        revision, created_at, updated_at
      ) VALUES ('role:builder', 'Builder', 'Build it.', '["worktree"]', ${model}, 'auto', 1,
        '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO crew_members (
        id, project_id, name, instructions, withheld_tools_json, model_selection_json,
        runtime_mode, created_at, updated_at
      ) VALUES ('member:builder', 'web', 'Builder', 'Build it.', '["device"]', ${model},
        'approval-required', '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO crew_runs (
        id, member_id, project_id, thread_id, task_text, title, instructions,
        withheld_tools_json, member_revision, model_selection_json, runtime_mode, created_at
      ) VALUES ('run-1', 'member:builder', 'web', 'bot-run:run-1', 'Do it.', 'Run', '',
        '["orchestration"]', 1, ${model}, 'auto-accept-edits', '2026-11-01'),
        ('bot-hq:captain', 'captain', 'web', 'bot-run:bot-hq:captain', 'Lead.', 'HQ', '',
        '[]', 1, ${model}, 'approval-required', '2026-11-01')
    `;

    yield* BosunMigrations.runMigrations(122);

    for (const table of ["bots", "roles", "crew_members"]) {
      const columns = yield* columnsOf(table);
      assert.isFalse(columns.includes("withheld_tools_json"), table);
      assert.isFalse(columns.includes("runtime_mode"), table);
    }
    const runColumns = yield* columnsOf("crew_runs");
    assert.isFalse(runColumns.includes("withheld_tools_json"));
    assert.deepStrictEqual(
      [
        yield* sql`SELECT id, name FROM bots`,
        yield* sql`SELECT id, instructions FROM roles WHERE id = 'role:builder'`,
        yield* sql`SELECT id, name FROM crew_members`,
        yield* sql`SELECT id, runtime_mode AS runtimeMode FROM crew_runs ORDER BY id`,
      ],
      [
        [{ id: "captain", name: "Captain" }],
        [{ id: "role:builder", instructions: "Build it." }],
        [{ id: "member:builder", name: "Builder" }],
        // A headquarters goes to full access; a run keeps the mode its thread started in.
        [
          { id: "bot-hq:captain", runtimeMode: "full-access" },
          { id: "run-1", runtimeMode: "auto-accept-edits" },
        ],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
