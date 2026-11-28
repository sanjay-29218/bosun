import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const MODEL = '{"instanceId":"codex","model":"gpt-5"}';
const BOX = '{"environmentId":"env-box","label":"Box"}';

it.effect("copies become imports, and the machine that copied them keeps who holds them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(127);
    yield* sql`
      INSERT INTO roles (
        id, name, instructions, model_selection_json, enabled, managed_from_json, revision,
        created_at, updated_at
      ) VALUES
        ('role:writer', 'Writer', 'Write.', ${MODEL}, 1, ${BOX}, 3, '2026-11-01', '2026-11-01'),
        ('role:own', 'Own', 'Mine.', ${MODEL}, 1, NULL, 2, '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO workflows (
        id, name, instructions, crew_role_ids_json, managed_from_json, revision, created_at,
        updated_at
      ) VALUES ('workflow:release', 'Release', 'Ship.', '["role:writer"]', ${BOX}, 1,
        '2026-11-01', '2026-11-01')
    `;
    yield* sql`
      INSERT INTO peer_environment_links (
        environment_id, secret_name, label, urls_json, access, linked_at, expires_at
      ) VALUES ('env-phone', 'secret', 'Phone', '[]', 'full-access', '2026-11-01', '2099-01-01')
    `;
    yield* sql`
      INSERT INTO library_copies
        (environment_id, kind, item_id, delivered_revision, delivered_at, problem)
      VALUES
        ('env-phone', 'role', 'role:own', 2, '2026-11-20', NULL),
        ('env-tablet', 'role', 'role:own', 1, '2026-11-19', NULL),
        ('env-phone', 'role', 'role:planner', NULL, NULL, 'It has its own Planner.')
    `;
    yield* sql`
      INSERT INTO library_copy_peers (environment_id, delivered_hash, delivered_at)
      VALUES ('env-phone', 'hash', '2026-11-20')
    `;
    yield* BosunMigrations.runMigrations(128);

    const roles = yield* sql<{
      readonly id: string;
      readonly importedFrom: string | null;
      readonly managedFrom: string | null;
    }>`
      SELECT id, imported_from_json AS importedFrom, managed_from_json AS managedFrom
      FROM roles ORDER BY id
    `;
    assert.deepStrictEqual(
      roles.map((role) => ({
        id: role.id,
        importedFrom: role.importedFrom === null ? null : JSON.parse(role.importedFrom),
        managedFrom: role.managedFrom,
      })),
      [
        { id: "role:own", importedFrom: null, managedFrom: null },
        {
          id: "role:writer",
          importedFrom: {
            environmentId: "env-box",
            label: "Box",
            revision: null,
            localRevision: 3,
            available: null,
            skipped: null,
            problem: null,
          },
          managedFrom: null,
        },
      ],
    );
    const [workflow] = yield* sql<{ readonly importedFrom: string }>`
      SELECT imported_from_json AS importedFrom FROM workflows
    `;
    assert.strictEqual(JSON.parse(workflow!.importedFrom).localRevision, 1);
    assert.deepStrictEqual(
      yield* sql`
        SELECT environment_id AS environmentId, label, kind, item_id AS itemId, revision, edited,
          push_revision AS pushRevision, seen_at AS seenAt
        FROM library_importers ORDER BY environment_id
      `,
      [
        {
          environmentId: "env-phone",
          label: "Phone",
          kind: "role",
          itemId: "role:own",
          revision: 2,
          edited: 0,
          pushRevision: null,
          seenAt: "2026-11-20",
        },
        {
          environmentId: "env-tablet",
          label: "env-tablet",
          kind: "role",
          itemId: "role:own",
          revision: 1,
          edited: 0,
          pushRevision: null,
          seenAt: "2026-11-19",
        },
      ],
    );
    const tables = (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name);
    assert.notInclude(tables, "library_copies");
    assert.notInclude(tables, "library_copy_peers");
    const members = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('crew_members')
    `;
    assert.include(
      members.map((column) => column.name),
      "fallback_model_selection_json",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
