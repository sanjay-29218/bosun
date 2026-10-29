import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const setUp = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* BosunMigrations.reconcileLegacyHistory();
  yield* BosunMigrations.runMigrations(76);
  yield* sql`
    INSERT INTO bots (
      id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
      created_at, updated_at
    ) VALUES ('social', 'Social', '{}', 'blue', '', '["crew.delegate"]', 'auto', 1,
      '2026-10-01', '2026-10-01')
  `;
  return sql;
});

const bots = (sql: SqlClient.SqlClient) =>
  sql<{ readonly id: string; readonly mode: string; readonly tools: string }>`
    SELECT id, runtime_mode AS mode, allowed_tools_json AS tools FROM bots ORDER BY position
  `.pipe(Effect.map((rows) => rows.map((row) => [row.id, row.mode, JSON.parse(row.tools).length])));

it.effect("gives a Captain nobody has saved full access and every tool", () =>
  Effect.gen(function* () {
    const sql = yield* setUp;
    yield* BosunMigrations.runMigrations(78);
    assert.deepStrictEqual(yield* bots(sql), [
      ["bot-captain", "full-access", 13],
      ["social", "auto", 1],
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps a Captain a person saved", () =>
  Effect.gen(function* () {
    const sql = yield* setUp;
    yield* sql`UPDATE bots SET revision = 2 WHERE id = 'bot-captain'`;
    yield* BosunMigrations.runMigrations(78);
    assert.deepStrictEqual((yield* bots(sql))[0], ["bot-captain", "approval-required", 5]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps a Captain carried over from the crew", () =>
  Effect.gen(function* () {
    const sql = yield* setUp;
    yield* sql`UPDATE bots SET created_at = '2026-09-01' WHERE id = 'bot-captain'`;
    yield* BosunMigrations.runMigrations(78);
    assert.deepStrictEqual((yield* bots(sql))[0], ["bot-captain", "approval-required", 5]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
