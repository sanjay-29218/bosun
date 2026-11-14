import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("permits every existing bot on every environment linked today", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(116);
    for (const id of ["captain", "social"]) {
      yield* sql`
        INSERT INTO bots (
          id, name, avatar_json, color, instructions, withheld_tools_json, runtime_mode, position,
          created_at, updated_at
        ) VALUES (${id}, ${id}, '{}', 'blue', '', '[]', 'auto', 1, '2026-11-01', '2026-11-01')
      `;
    }
    for (const id of ["vps", "studio"]) {
      yield* sql`
        INSERT INTO peer_environment_links (
          environment_id, secret_name, label, urls_json, access, linked_at, expires_at
        ) VALUES (${id}, ${`secret-${id}`}, ${id}, '[]', 'full-access', '2026-11-01', '2027-11-01')
      `;
    }

    yield* BosunMigrations.runMigrations(117);

    assert.deepStrictEqual(
      yield* sql`SELECT id, permitted_environment_ids_json AS permitted FROM bots ORDER BY id`,
      [
        { id: "captain", permitted: '["studio","vps"]' },
        { id: "social", permitted: '["studio","vps"]' },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
