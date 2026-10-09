import { ProjectId, type WorkflowDefinition } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as BosunMigrations from "../persistence/BosunMigrations.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { WorkflowStore, WorkflowStoreLive } from "./WorkflowStore.ts";

const projectId = ProjectId.make("workflow-test-project");
const first: WorkflowDefinition = {
  schemaVersion: 1,
  id: "delivery",
  name: "Delivery",
  revision: 1,
  start: "build",
  bots: {
    builder: {
      template: { kind: "template", id: "custom-builder", revision: 1 },
      supervisor: null,
    },
  },
  steps: {
    build: { type: "task", bot: "builder", task: "Build", next: { built: "end" } },
    end: { type: "end" },
  },
  defaults: {
    questions: "supervisor",
    failure: "pause",
    maxAttemptsPerExecution: 3,
    maxStepExecutions: 30,
  },
};

it.effect("keeps revisions and feature copies independent across later edits", () =>
  Effect.gen(function* () {
    const store = yield* WorkflowStore;
    const sql = yield* SqlClient.SqlClient;
    assert.isTrue(yield* store.createDefinition(projectId, first, "2026-09-29T00:00:00Z"));
    assert.isFalse(yield* store.createDefinition(projectId, first, "2026-09-29T00:00:00Z"));

    const featureOne = yield* store.copyForFeature(
      "feature-1",
      projectId,
      first.id,
      1,
      "2026-09-29T00:01:00Z",
    );
    assert.strictEqual(featureOne?.definition.revision, 1);

    const second: WorkflowDefinition = { ...first, name: "Delivery revised", revision: 2 };
    assert.isTrue(yield* store.updateDefinition(projectId, second, 1, "2026-09-29T00:02:00Z"));
    assert.isFalse(yield* store.updateDefinition(projectId, second, 1, "2026-09-29T00:02:00Z"));
    assert.deepEqual(yield* store.getDefinition(projectId, first.id, 1), first);
    assert.deepEqual(yield* store.getLatestDefinition(projectId, first.id), second);

    const featureOneAgain = yield* store.copyForFeature(
      "feature-1",
      projectId,
      first.id,
      1,
      "2026-09-29T00:03:00Z",
    );
    const featureTwo = yield* store.copyForFeature(
      "feature-2",
      projectId,
      first.id,
      2,
      "2026-09-29T00:03:00Z",
    );
    assert.deepEqual(featureOneAgain, featureOne);
    assert.strictEqual(featureTwo?.definition.revision, 2);
    const event = {
      id: "start-build",
      stepId: "build",
      kind: "started" as const,
      executionId: "execution-1",
      botRunId: "run-build-1",
      outcome: null,
      sourceKind: null,
      sourceId: null,
      actorId: "manager",
      detail: null,
      occurredAt: "2026-09-29T00:04:00Z",
    };
    assert.deepEqual(yield* store.appendEvent("feature-1", 0, event), {
      kind: "inserted",
      event,
    });
    assert.deepEqual(yield* store.appendEvent("feature-1", 0, event), {
      kind: "duplicate",
      event,
    });
    assert.deepEqual(yield* store.appendEvent("feature-1", 0, { ...event, id: "another-start" }), {
      kind: "conflict",
    });
    assert.deepEqual(yield* store.listEvents("feature-1"), [event]);
    assert.strictEqual((yield* store.getFeatureCopy("feature-1"))?.eventVersion, 1);
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(
    Effect.provide(WorkflowStoreLive.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
  ),
);

it.effect("migrates an existing bots database without damaging its rows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.runMigrations(59);
    yield* sql`
      INSERT INTO bot_templates (
        id, project_id, name, instructions, allowed_tools_json,
        model_selection_json, runtime_mode, created_at, updated_at
      ) VALUES (
        'template:existing', 'project', 'Existing', 'Work', '[]',
        '{"instanceId":"codex","model":"gpt-5"}', 'approval-required',
        '2026-09-28', '2026-09-28'
      )
    `;
    yield* runMigrations();
    const templates = yield* sql<{ readonly id: string }>`SELECT id FROM bot_templates`;
    const workflowTables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%workflow%' AND name NOT LIKE 'orchestration_v2_%'
      ORDER BY name
    `;
    assert.deepEqual(
      templates.map((row) => row.id),
      ["template:existing"],
    );
    assert.deepEqual(
      workflowTables.map((row) => row.name),
      [
        "feature_workflows",
        "workflow_definition_heads",
        "workflow_definition_revisions",
        "workflow_executions",
        "workflow_step_events",
      ],
    );
    assert.deepEqual(yield* sql`PRAGMA foreign_key_check`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
