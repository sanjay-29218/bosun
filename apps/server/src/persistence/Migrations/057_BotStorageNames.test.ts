import * as BosunMigrations from "../BosunMigrations.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationEntries, runMigrations } from "../Migrations.ts";

const fresh = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));
const legacy = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

fresh("new bot storage", (it) => {
  it.effect("creates separate bot templates and instances on a new database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%bot%'
        ORDER BY name
      `;
      assert.deepStrictEqual(
        tables.map((row) => row.name),
        [
          "bot_delegation_grants",
          "bot_handoff_receipts",
          "bot_handoffs",
          "bot_hierarchy",
          "bot_runs",
          "bot_templates",
          "bots",
        ],
      );
    }),
  );
});

legacy("legacy bot storage", (it) => {
  it.effect("preserves existing bots, runs, handoffs, and foreign keys", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* BosunMigrations.runMigrations(56);
      yield* sql`
        INSERT INTO bosun_bot_definitions (
          id, project_id, role, name, instructions, allowed_tools_json,
          model_selection_json, runtime_mode, created_at, updated_at
        ) VALUES
          ('bosun-captain', NULL, 'captain', 'Captain', 'Coordinate', '["bots.delegate"]',
            '{"provider":"codex","model":"gpt-5"}', 'approval-required', '2026-09-27', '2026-09-27'),
          ('bosun-manager:project', 'project', 'manager', 'Manager', 'Manage', '["bots.delegate"]',
            '{"provider":"codex","model":"gpt-5"}', 'approval-required', '2026-09-27', '2026-09-27'),
          ('bosun-execution:project', 'project', 'execution', 'Execution', 'Build the task', '[]',
            '{"provider":"codex","model":"gpt-5"}', 'approval-required', '2026-09-27', '2026-09-27')
      `;
      yield* sql`
        INSERT INTO bosun_bot_runs (
          id, bot_id, project_id, thread_id, task_text, title, instructions,
          allowed_tools_json, bot_revision, model_selection_json, runtime_mode, created_at
        ) VALUES (
          'old-run', 'bosun-execution:project', 'project', 'old-thread', 'Build', 'Build', 'Build the task',
          '[]', 1, '{"provider":"codex","model":"gpt-5"}', 'approval-required', '2026-09-27'
        )
      `;
      yield* sql`
        INSERT INTO bosun_bot_handoffs (
          id, source_run_id, target_bot_id, target_run_id, project_id,
          task_text, context_text, depth, status, created_at, updated_at
        ) VALUES (
          'old-handoff', 'old-run', 'bosun-execution:project', 'next-run', 'project',
          'Review', '', 1, 'completed', '2026-09-27', '2026-09-27'
        )
      `;
      yield* sql`UPDATE bosun_sql_migrations SET name = 'BosunBots' WHERE migration_id = 55`;
      yield* sql`UPDATE bosun_sql_migrations SET name = 'BosunHandoffs' WHERE migration_id = 56`;

      // Reproduce the old fork's shared migration ledger, including colliding IDs.
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        SELECT migration_id, name, created_at FROM bosun_sql_migrations`;
      yield* sql`DROP TABLE bosun_sql_migrations`;
      yield* runMigrations();
      yield* runMigrations();
      const upstream = yield* sql<{ readonly name: string }>`
        SELECT name FROM effect_sql_migrations WHERE migration_id >= 55 ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        upstream.map((row) => row.name),
        migrationEntries.filter(([id]) => id >= 55).map(([, name]) => name),
      );
      const domain = yield* sql<{ readonly name: string }>`
        SELECT name FROM bosun_sql_migrations WHERE migration_id <= 59 ORDER BY migration_id
      `;
      assert.deepStrictEqual(
        domain.map((row) => row.name),
        ["Bots", "BotHandoffs", "BotStorageNames", "BotTemplates", "BotHierarchy"],
      );
      const v2Tables =
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_runs'`;
      assert.strictEqual(v2Tables.length, 1);

      const bots = yield* sql<{ readonly id: string; readonly templateId: string | null }>`
        SELECT id, template_id AS templateId FROM bots
      `;
      const runs = yield* sql<{ readonly id: string; readonly botId: string }>`
        SELECT id, bot_id AS botId FROM bot_runs
      `;
      const handoffs = yield* sql<{ readonly id: string; readonly targetBotId: string }>`
        SELECT id, target_bot_id AS targetBotId FROM bot_handoffs
      `;
      const foreignKeyErrors = yield* sql`PRAGMA foreign_key_check`;
      const oldNames = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name LIKE 'bosun_bot_%' OR name = 'bot_definitions'
      `;
      assert.deepStrictEqual(bots.map((bot) => bot.id).sort(), [
        "bot-builder:project",
        "bot-captain",
        "bot-manager:project",
      ]);
      assert.deepStrictEqual(
        bots.map((bot) => bot.templateId),
        [null, null, null],
      );
      const grants = yield* sql<{ readonly sourceBotId: string; readonly targetBotId: string }>`
        SELECT source_bot_id AS sourceBotId, target_bot_id AS targetBotId
        FROM bot_delegation_grants ORDER BY source_bot_id
      `;
      assert.deepStrictEqual(grants, [
        { sourceBotId: "bot-captain", targetBotId: "bot-manager:project" },
        { sourceBotId: "bot-manager:project", targetBotId: "bot-builder:project" },
      ]);
      assert.deepStrictEqual(
        runs.map((row) => row.id),
        ["old-run"],
      );
      assert.strictEqual(runs[0]?.botId, "bot-builder:project");
      assert.deepStrictEqual(
        handoffs.map((row) => row.id),
        ["old-handoff"],
      );
      assert.strictEqual(handoffs[0]?.targetBotId, "bot-builder:project");
      const hierarchy = yield* sql<{ readonly botId: string; readonly parentBotId: string | null }>`
        SELECT bot_id AS botId, parent_bot_id AS parentBotId FROM bot_hierarchy ORDER BY bot_id
      `;
      assert.deepStrictEqual(hierarchy, [
        { botId: "bot-builder:project", parentBotId: "bot-manager:project" },
        { botId: "bot-captain", parentBotId: null },
        { botId: "bot-manager:project", parentBotId: "bot-captain" },
      ]);
      assert.deepStrictEqual(foreignKeyErrors, []);
      assert.deepStrictEqual(oldNames, []);
    }),
  );
});
