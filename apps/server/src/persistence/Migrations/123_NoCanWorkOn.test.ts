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

it.effect("drops the Can work on lists bots and project managers saved", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(122);
    yield* sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, permitted_environment_ids_json, position,
        created_at, updated_at
      ) VALUES ('captain', 'Captain', '{}', 'blue', '', '["vps"]', 1, '2026-11-01', '2026-11-01')
    `;
    yield* sql`UPDATE projection_projects SET manager_permitted_environment_ids_json = '["vps"]'`;

    yield* BosunMigrations.runMigrations(123);

    assert.notInclude(yield* columnsOf("bots"), "permitted_environment_ids_json");
    assert.notInclude(
      yield* columnsOf("projection_projects"),
      "manager_permitted_environment_ids_json",
    );
    assert.deepStrictEqual(yield* sql`SELECT id, name FROM bots`, [
      { id: "captain", name: "Captain" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
