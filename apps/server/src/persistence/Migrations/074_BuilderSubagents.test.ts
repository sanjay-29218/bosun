import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const OLD =
  "You are the Builder. Follow the assigned task in the linked T3 thread. Call crew_respond with a structured outcome and a concise summary when finished. If information is missing, call crew_ask with the exact question, then continue after an answer. Do not report completion solely in prose.";

it.effect("lets the Builder run parallel subagents, keeping edited instructions", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(73);
    const role = (id: string, instructions: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, '["crew.respond","crew.ask"]',
        '{"instanceId":"codex","model":"gpt-5"}', 'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* role("role:builder", OLD);
    yield* role("role:planner", "Plan it.");

    yield* runMigrations();

    const rows = yield* sql<{ readonly id: string; readonly tools: string; readonly text: string }>`
      SELECT id, allowed_tools_json AS tools, instructions AS text FROM roles ORDER BY id
    `;
    const builder = rows.find((row) => row.id === "role:builder")!;
    assert.deepStrictEqual(JSON.parse(builder.tools), [
      "crew.respond",
      "crew.ask",
      "orchestration",
    ]);
    assert.include(builder.text, "delegate_task");
    const planner = rows.find((row) => row.id === "role:planner")!;
    assert.deepStrictEqual(JSON.parse(planner.tools), ["crew.respond", "crew.ask"]);
    assert.strictEqual(planner.text, "Plan it.");

    // Edited builder instructions stay as written; running it again changes nothing.
    yield* sql`UPDATE roles SET instructions = 'My own' WHERE id = 'role:builder'`;
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
