import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("drops the Project manager role, keeping each project's manager as it was", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(110);
    const role = (id: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        enabled, auto_create_for_feature, revision, created_at, updated_at
      ) VALUES (${id}, ${id}, 'Do it.', '[]', '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', 1, 0, 3, '2026-11-01', '2026-11-01')
    `;
    yield* role("role:project-manager");
    yield* role("role:builder");
    const member = (id: string, roleId: string) => sql`
      INSERT INTO crew_members (
        id, project_id, role_id, role_revision, name, instructions, allowed_tools_json,
        model_selection_json, runtime_mode, enabled, revision, created_at, updated_at
      ) VALUES (${id}, 'web', ${roleId}, 3, ${id}, 'Manage web.', '[]',
        '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 1, 1, '2026-11-01', '2026-11-01')
    `;
    yield* member("project-manager:web", "role:project-manager");
    yield* member("builder:web", "role:builder");

    yield* BosunMigrations.runMigrations(112);

    assert.deepStrictEqual(yield* sql`SELECT id FROM roles ORDER BY id`, [{ id: "role:builder" }]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT id, role_id AS roleId, role_revision AS roleRevision, instructions
        FROM crew_members ORDER BY id
      `,
      [
        { id: "builder:web", roleId: "role:builder", roleRevision: 3, instructions: "Manage web." },
        {
          id: "project-manager:web",
          roleId: null,
          roleRevision: null,
          instructions: "Manage web.",
        },
      ],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
