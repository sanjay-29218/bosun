import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";
import { HEADQUARTERS_REWRITE } from "./099_LinkedProjects.ts";

it.effect("tells stock headquarters about their projects on linked environments", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(98);
    const run = (id: string, taskText: string) => sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES (${id}, 'social', 'project', ${`bot-run:${id}`}, ${taskText}, 'Run', '', '[]', 1,
        '{}', 'auto', '2026-11-01')
    `;
    const listed = (botId: string) =>
      `You run this bot's work across the projects it owns: the ones t3_project_list shows with botId "${botId}".`;
    yield* run("bot-hq:social", `${listed("social")}\n\n${HEADQUARTERS_REWRITE[0]}\n\nRelay it.`);
    yield* run("bot-hq:edited", "Hand everything to me first.");
    // A run's task is its identity, so a project manager's keeps its words.
    yield* run("bot-handoff:h1", HEADQUARTERS_REWRITE[0]);

    yield* BosunMigrations.runMigrations(99);

    const task = (id: string) =>
      sql<{ readonly text: string }>`SELECT task_text AS text FROM crew_runs WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]!.text),
      );
    assert.strictEqual(
      yield* task("bot-hq:social"),
      `You run this bot's work across the projects it owns: t3_bot_projects lists them, here and on linked environments, each with its environmentId.\n\n${HEADQUARTERS_REWRITE[1]}\n\nRelay it.`,
    );
    assert.include(HEADQUARTERS_REWRITE[1], "target.environmentId");
    assert.strictEqual(yield* task("bot-hq:edited"), "Hand everything to me first.");
    assert.strictEqual(yield* task("bot-handoff:h1"), HEADQUARTERS_REWRITE[0]);

    // 100: a link's request keeps the workflow it brought, and its features their own copy.
    yield* BosunMigrations.runMigrations(100);
    const featureColumns = yield* sql<{ readonly name: string; readonly notnull: number }>`
      SELECT name, "notnull" FROM pragma_table_info('features')
    `;
    assert.deepInclude(featureColumns, { name: "workflow_snapshot_json", notnull: 0 });
    const runWorkflowColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('crew_run_workflows')
    `;
    assert.deepStrictEqual(
      runWorkflowColumns.map((column) => column.name),
      ["run_id", "workflow_json"],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
