import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const role = (roleId: string, supervisor: string | null = "manager") => ({
  roleId,
  roleRevision: 2,
  supervisor,
});
const task = (role: string, text: string, next: object, extra: object = {}) => ({
  type: "task",
  role,
  task: text,
  next,
  ...extra,
});
const STOCK = {
  schemaVersion: 2,
  id: "feature-delivery",
  name: "Feature delivery",
  revision: 2,
  start: "plan",
  roles: {
    manager: role("role:project-manager", null),
    planner: role("role:planner"),
    designer: role("role:designer"),
    builder: role("role:builder"),
    qa: role("role:qa-tester"),
    reviewer: role("role:reviewer"),
  },
  steps: {
    plan: task(
      "planner",
      "Plan the feature",
      { ready: "design" },
      {
        gate: true,
        outputs: ["plan.md"],
      },
    ),
    design: task(
      "designer",
      "Design the feature",
      { ready: "build" },
      {
        gate: true,
        outputs: ["design.md"],
      },
    ),
    build: task("builder", "Build the feature", {
      built: "qa",
      design_change_requested: "change_review",
    }),
    qa: task(
      "qa",
      "Test the feature",
      { passed: "review", changes_requested: "change_review" },
      { outputs: ["qa-report.md"] },
    ),
    review: task(
      "reviewer",
      "Review the feature",
      { approved: "end", changes_requested: "change_review" },
      { limits: { changes_requested: 3 } },
    ),
    change_review: task("manager", "Decide how to handle the requested change", {
      revise_design: "design",
      revise_build: "build",
    }),
    end: { type: "end" },
  },
  defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
  layout: { plan: { x: 0, y: 0 }, review: { x: 4, y: 0 } },
};

it.effect("slims an unedited Feature delivery and leaves an edited one alone", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(87);
    const insert = (id: string, definition: object) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO workflow_definition_heads (id, revision) VALUES (${id}, 2)`;
        yield* sql`
          INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
          VALUES (${id}, 2, ${JSON.stringify(definition)}, '2026-10-01')
        `;
      });
    yield* insert("feature-delivery", STOCK);

    yield* BosunMigrations.runMigrations(88);

    const head = (id: string) =>
      sql<{ readonly revision: number; readonly json: string }>`
        SELECT h.revision, r.definition_json AS json FROM workflow_definition_heads AS h
        JOIN workflow_definition_revisions AS r ON r.id = h.id AND r.revision = h.revision
        WHERE h.id = ${id}
      `.pipe(Effect.map(([row]) => ({ revision: row!.revision, ...JSON.parse(row!.json) })));
    const slim = yield* head("feature-delivery");
    assert.strictEqual(slim.revision, 3);
    assert.deepStrictEqual(Object.keys(slim.steps), ["plan", "design", "build", "qa", "end"]);
    assert.isTrue(slim.steps.plan.gate && slim.steps.design.gate);
    assert.deepStrictEqual(slim.steps.qa.next, { passed: "end", changes_requested: "build" });
    assert.deepStrictEqual(slim.steps.qa.limits, { changes_requested: 2 });
    assert.deepStrictEqual(slim.steps.build.next, {
      built: "qa",
      design_change_requested: "design",
    });
    assert.notProperty(slim.roles, "reviewer");
    assert.strictEqual(slim.roles.builder.roleRevision, 2);
    assert.deepStrictEqual(slim.layout, { plan: { x: 0, y: 0 } });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps a Feature delivery whose steps were edited", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(87);
    const edited = {
      ...STOCK,
      steps: { ...STOCK.steps, plan: { ...STOCK.steps.plan, task: "Plan it my way" } },
    };
    yield* sql`INSERT INTO workflow_definition_heads (id, revision) VALUES ('feature-delivery', 2)`;
    yield* sql`
      INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
      VALUES ('feature-delivery', 2, ${JSON.stringify(edited)}, '2026-10-01')
    `;

    yield* BosunMigrations.runMigrations(88);

    const [head] = yield* sql<{ readonly revision: number }>`
      SELECT revision FROM workflow_definition_heads WHERE id = 'feature-delivery'
    `;
    assert.strictEqual(head!.revision, 2);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
