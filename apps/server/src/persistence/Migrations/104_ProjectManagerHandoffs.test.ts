import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";
import { BOT_REWRITE, HEADQUARTERS_REWRITE } from "./098_ProjectHandoffs.ts";
import { BOT_HANDOFF, HEADQUARTERS_HANDOFF } from "./104_ProjectManagerHandoffs.ts";

it.effect("routes stock bot and headquarters text to the Project manager, keeping edits", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(103);
    const bot = (id: string, instructions: string) => sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
        created_at, updated_at
      ) VALUES (${id}, ${id}, '{}', 'blue', ${instructions}, '[]', 'auto', 1,
        '2026-11-01', '2026-11-01')
    `;
    yield* bot("stock", `Coordinate. ${BOT_REWRITE[1]} Relay it.`);
    yield* bot("edited", "Hand everything to me first.");
    const run = (id: string, taskText: string) => sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES (${id}, 'stock', 'project', ${`bot-run:${id}`}, ${taskText}, 'Run', '', '[]', 1,
        '{}', 'auto', '2026-11-01')
    `;
    yield* run("bot-hq:stock", `You run this bot's work.\n\n${HEADQUARTERS_REWRITE[1]}`);
    yield* run("bot-hq:edited", "Do it all yourself.");
    // A task's text is its identity, so one a headquarters started keeps its words.
    yield* run("task", HEADQUARTERS_REWRITE[1]);

    yield* BosunMigrations.runMigrations(104);

    const text = (table: "bots" | "crew_runs", id: string) =>
      (table === "bots"
        ? sql<{ readonly text: string }>`SELECT instructions AS text FROM bots WHERE id = ${id}`
        : sql<{ readonly text: string }>`SELECT task_text AS text FROM crew_runs WHERE id = ${id}`
      ).pipe(Effect.map((rows) => rows[0]!.text));
    assert.strictEqual(yield* text("bots", "stock"), `Coordinate. ${BOT_HANDOFF} Relay it.`);
    assert.strictEqual(yield* text("bots", "edited"), "Hand everything to me first.");
    assert.strictEqual(
      yield* text("crew_runs", "bot-hq:stock"),
      `You run this bot's work.\n\n${HEADQUARTERS_HANDOFF}`,
    );
    assert.strictEqual(yield* text("crew_runs", "bot-hq:edited"), "Do it all yourself.");
    assert.strictEqual(yield* text("crew_runs", "task"), HEADQUARTERS_REWRITE[1]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
