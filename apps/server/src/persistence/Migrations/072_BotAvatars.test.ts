import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("gives Captain the first avatar and other bots one by rail position", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(71);
    const bot = (id: string, emoji: string, position: number) => sql`
      INSERT INTO bots (
        id, name, emoji, color, instructions, allowed_tools_json, runtime_mode, position,
        created_at, updated_at
      ) VALUES (${id}, ${id}, ${emoji}, 'blue', '', '[]', 'auto', ${position},
        '2026-10-01', '2026-10-01')
    `;
    yield* bot("finance", "💰", 2);
    yield* bot("social", "📣", 1);

    yield* runMigrations();

    const rows = yield* sql<{ readonly id: string; readonly avatar: string }>`
      SELECT id, avatar_json AS avatar FROM bots ORDER BY position
    `;
    assert.deepStrictEqual(
      rows.map((row) => [row.id, JSON.parse(row.avatar).eyes]),
      [
        ["bot-captain", "round"],
        ["social", "happy"],
        ["finance", "visor"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
