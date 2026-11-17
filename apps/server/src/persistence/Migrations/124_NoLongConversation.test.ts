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

it.effect("drops the Long conversations setting bots and project managers saved", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(123);
    const model = '{"instanceId":"codex","model":"gpt-5"}';
    yield* sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, long_conversation, position,
        created_at, updated_at
      ) VALUES ('captain', 'Captain', '{}', 'blue', '', 'new-session', 1, '2026-11-01',
        '2026-11-01')
    `;
    yield* sql`
      INSERT INTO crew_members (
        id, project_id, name, instructions, model_selection_json, long_conversation,
        created_at, updated_at
      ) VALUES ('project-manager:web', 'web', 'Project manager', 'Run it.', ${model},
        'new-session', '2026-11-01', '2026-11-01')
    `;

    yield* BosunMigrations.runMigrations(124);

    for (const table of ["bots", "crew_members"]) {
      assert.notInclude(yield* columnsOf(table), "long_conversation", table);
    }
    assert.deepStrictEqual(
      [yield* sql`SELECT id FROM bots`, yield* sql`SELECT id FROM crew_members`],
      [[{ id: "captain" }], [{ id: "project-manager:web" }]],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
