import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const STARTER =
  "You are the Reviewer. Call crew_respond with a structured outcome. Do not report completion solely in prose.";

it.effect("asks starter stage roles for focused checks, keeping edited ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(81);
    const role = (id: string, instructions: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, '["crew.respond"]',
        '{"instanceId":"codex","model":"gpt-5"}', 'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* role("role:reviewer", STARTER);
    yield* role("role:mine", "Review it my way.");

    yield* BosunMigrations.runMigrations(82);

    const rows = yield* sql<{ readonly id: string; readonly text: string }>`
      SELECT id, instructions AS text FROM roles ORDER BY id
    `;
    const text = (id: string) => rows.find((row) => row.id === id)!.text;
    assert.include(text("role:reviewer"), `${STARTER} Keep checks in proportion`);
    assert.strictEqual(text("role:mine"), "Review it my way.");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
