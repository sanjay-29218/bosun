import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

it.effect("upgrades a feature database with Crew queue storage, then drops the engine's", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(66);
    yield* sql`INSERT INTO workflow_definition_heads VALUES ('project', 'workflow', 1)`;
    yield* sql`
      INSERT INTO workflow_definition_revisions
      VALUES ('project', 'workflow', 1, '{}', '2026-10-01')
    `;
    yield* sql`
      INSERT INTO feature_workflows
        (feature_id, project_id, workflow_id, workflow_revision, definition_json, created_at)
      VALUES ('feature-one', 'project', 'workflow', 1, '{}', '2026-10-01')
    `;
    yield* sql`
      INSERT INTO workflow_executions (feature_id, bindings_json) VALUES ('feature-one', '{}')
    `;
    yield* runMigrations();
    // 093 removed the workflow engine and its storage.
    assert.deepStrictEqual(
      yield* sql`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND (name LIKE 'workflow_%' OR name IN ('feature_workflows', 'crew_stage_threads'))
      `,
      [],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
