import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("lets Captain manage workflows, leaving other bots as they are", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(75);
    yield* sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
        created_at, updated_at
      ) VALUES ('social', 'Social', '{}', 'blue', '', '["crew.delegate"]', 'auto', 1,
        '2026-10-01', '2026-10-01')
    `;

    yield* runMigrations();

    const rows = yield* sql<{ readonly id: string; readonly tools: string }>`
      SELECT id, allowed_tools_json AS tools FROM bots ORDER BY position
    `;
    assert.deepStrictEqual(
      rows.map((row) => [row.id, JSON.parse(row.tools)]),
      [
        [
          "bot-captain",
          ["crew.delegate", "crew.status", "crew.answer", "crew.projects", "crew.workflows"],
        ],
        ["social", ["crew.delegate"]],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
