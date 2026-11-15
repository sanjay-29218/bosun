import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("keeps every existing bot and project manager in the rail", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(114);
    yield* sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
        created_at, updated_at
      ) VALUES ('social', 'Social', '{}', 'blue', '', '[]', 'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, bot_id
      ) VALUES ('web', 'web', '/work/web', '[]', '2026-11-01', '2026-11-01', 'social')
    `;

    yield* BosunMigrations.runMigrations(115);

    assert.deepStrictEqual(yield* sql`SELECT id, pinned FROM bots ORDER BY id`, [
      { id: "social", pinned: 1 },
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT project_id AS id, manager_pinned AS pinned FROM projection_projects`,
      [{ id: "web", pinned: 1 }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
