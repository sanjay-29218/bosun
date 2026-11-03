import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";
import Features from "./062_Features.ts";
import BotHandoffReceipts from "./063_BotHandoffReceipts.ts";
import WorkflowExecutions from "./064_WorkflowExecutions.ts";

it.effect("upgrades a Feature-only database without skipping Workflow storage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 59 });
    yield* Features;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES (62, 'Features', CURRENT_TIMESTAMP)
    `;
    yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at)
      VALUES ('feature-one', 'project', 'Existing feature', 'Keep this brief', '2026-09-30')
    `;
    yield* runMigrations();
    assert.deepStrictEqual(
      yield* sql`SELECT title, brief, brief_message_json AS openingMessage, brief_request_hash AS requestHash FROM features`,
      [
        {
          title: "Existing feature",
          brief: "Keep this brief",
          openingMessage: null,
          requestHash: null,
        },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT status, updated_at, crew_assignments_json FROM features`,
      [{ status: "open", updated_at: "2026-09-30", crew_assignments_json: "{}" }],
    );
    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("upgrades a Workflow-only database, then drops the engine's storage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.runMigrations(61);
    yield* BotHandoffReceipts;
    yield* WorkflowExecutions;
    yield* sql`
      INSERT INTO effect_sql_migrations (migration_id, name, created_at)
      VALUES (63, 'BotHandoffReceipts', CURRENT_TIMESTAMP),
        (64, 'WorkflowExecutions', CURRENT_TIMESTAMP)
    `;
    yield* sql`INSERT INTO workflow_definition_heads VALUES ('project', 'workflow', 1)`;
    yield* sql`
      INSERT INTO workflow_definition_revisions
      VALUES ('project', 'workflow', 1, '{"revision":1}', '2026-09-30')
    `;
    yield* sql`
      INSERT INTO feature_workflows
        (feature_id, project_id, workflow_id, workflow_revision, definition_json, created_at, event_version)
      VALUES ('feature-one', 'project', 'workflow', 1, '{"revision":1}', '2026-09-30', 1)
    `;
    yield* sql`
      INSERT INTO workflow_step_events (feature_id, event_id, event_json, occurred_at)
      VALUES ('feature-one', 'existing-event', '{"kind":"paused"}', '2026-09-30')
    `;
    yield* runMigrations();
    yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at)
      VALUES ('new-feature', 'project', 'New feature', 'A brief', '2026-09-30')
    `;
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
