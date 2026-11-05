import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "existing crew members start uncustomized and compacting, so they follow their role",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      yield* BosunMigrations.reconcileLegacyHistory();
      yield* BosunMigrations.runMigrations(101);
      yield* sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        enabled, auto_create_for_feature, created_at, updated_at
      ) VALUES ('role:project-manager', 'Project manager', 'Lead.', '[]',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 1, 0, '2026-11-01', '2026-11-01')
    `;
      yield* sql`
      INSERT INTO crew_members (
        id, project_id, role_id, role_revision, name, instructions, allowed_tools_json,
        model_selection_json, runtime_mode, enabled, revision, created_at, updated_at
      ) VALUES (
        'bot-manager:web', 'web', 'role:project-manager', 1, 'Project manager', 'Lead.', '[]',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 1, 1, '2026-11-01', '2026-11-01'
      )
    `;

      yield* BosunMigrations.runMigrations(102);
      yield* BosunMigrations.runMigrations(102);

      assert.deepStrictEqual(
        yield* sql`SELECT id, customized_at AS customizedAt FROM crew_members`,
        [{ id: "bot-manager:web", customizedAt: null }],
      );

      // 104: every member compacts a long conversation until its project says otherwise.
      yield* BosunMigrations.runMigrations(104);
      yield* BosunMigrations.runMigrations(104);
      assert.deepStrictEqual(
        yield* sql`SELECT long_conversation AS longConversation FROM crew_members`,
        [{ longConversation: "compact" }],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
