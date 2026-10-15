import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.effect(
  "preserves existing workflow execution bindings when adding durable feature launches",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* runMigrations({ toMigrationInclusive: 66 });
      yield* sql`INSERT INTO workflow_definition_heads VALUES ('project', 'workflow', 1)`;
      yield* sql`INSERT INTO workflow_definition_revisions VALUES ('project', 'workflow', 1, '{}', '2026-09-30')`;
      yield* sql`INSERT INTO feature_workflows
      (feature_id, project_id, workflow_id, workflow_revision, definition_json, created_at)
      VALUES ('existing-feature', 'project', 'workflow', 1, '{}', '2026-09-30')`;
      yield* sql`INSERT INTO workflow_executions (feature_id, bindings_json, last_error, settled)
      VALUES ('existing-feature', '{"custom":{"botId":"bot","dispatchRunId":"run"}}', 'Keep the error', 1)`;
      yield* runMigrations();
      assert.deepStrictEqual(yield* sql`SELECT * FROM workflow_executions`, [
        {
          feature_id: "existing-feature",
          bindings_json: '{"custom":{"botId":"bot","dispatchRunId":"run"}}',
          last_error: "Keep the error",
          settled: 1,
          feature_context: "",
        },
      ]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM feature_launches`, []);
      assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
