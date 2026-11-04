import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";
import { BOT_REWRITE, HEADQUARTERS_REWRITE } from "./098_ProjectHandoffs.ts";

it.effect("offers bots a task or a feature, and lets a feature remember who started it", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(97);
    const bot = (id: string, instructions: string) => sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
        created_at, updated_at
      ) VALUES (${id}, ${id}, '{}', 'blue', ${instructions}, '[]', 'auto', 1,
        '2026-11-01', '2026-11-01')
    `;
    yield* bot("social", `You are Social. Coordinate. ${BOT_REWRITE[0]} Relay it.`);
    yield* bot("edited", "Hand everything to me first.");
    const run = (id: string, taskText: string) => sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES (${id}, 'social', 'project', ${`bot-run:${id}`}, ${taskText}, 'Run', '', '[]', 1,
        '{}', 'auto', '2026-11-01')
    `;
    yield* run("bot-hq:social", `You run this bot's work.\n\n${HEADQUARTERS_REWRITE[0]}`);
    // A run's task is its identity, so a project manager's keeps its words.
    yield* run("bot-handoff:h1", HEADQUARTERS_REWRITE[0]);

    yield* BosunMigrations.runMigrations(98);

    const [social] = yield* sql<{ readonly text: string }>`
      SELECT instructions AS text FROM bots WHERE id = 'social'
    `;
    assert.strictEqual(social!.text, `You are Social. Coordinate. ${BOT_REWRITE[1]} Relay it.`);
    const [edited] = yield* sql<{ readonly text: string }>`
      SELECT instructions AS text FROM bots WHERE id = 'edited'
    `;
    assert.strictEqual(edited!.text, "Hand everything to me first.");
    const task = (id: string) =>
      sql<{ readonly text: string }>`SELECT task_text AS text FROM crew_runs WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]!.text),
      );
    assert.strictEqual(
      yield* task("bot-hq:social"),
      `You run this bot's work.\n\n${HEADQUARTERS_REWRITE[1]}`,
    );
    assert.strictEqual(yield* task("bot-handoff:h1"), HEADQUARTERS_REWRITE[0]);
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('features')
    `;
    assert.isTrue(columns.some((column) => column.name === "requester_thread_id"));
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
