import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const MANAGER =
  "You lead one project's features. A feature's brief is your first message. Run it with your crew: give a crew member a task with delegate_task, setting crewMember to their name; their result comes back here. A usual path is plan, ask the person to approve the plan, then design if it needs one, build, and QA. Skip what the work doesn't need, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the feature is done, say so and summarize what changed.";

it.effect(
  "gives an existing crew Feature delivery, led by its manager with its feature roles",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 69 });
      yield* BosunMigrations.reconcileLegacyHistory();
      yield* BosunMigrations.runMigrations(94);
      const role = (
        id: string,
        instructions: string,
        joinsFeatures: boolean,
        enabled = true,
      ) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        enabled, auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, '[]', '{"instanceId":"codex","model":"gpt-5"}',
        'auto', ${enabled ? 1 : 0}, ${joinsFeatures ? 1 : 0}, ${`2026-10-0${id.length % 9}`},
        '2026-10-01')
    `;
      yield* role("role:project-manager", MANAGER, false);
      yield* role("role:planner", "Plan.", true);
      yield* role("role:builder", "Build.", true);
      yield* role("role:retired", "Retired.", true, false);
      yield* role("role:helper", "Help on request.", false);
      yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at, updated_at, status, crew_assignments_json)
      VALUES ('feature-one', 'project', 'One', 'Brief', '2026-10-01', '2026-10-01', 'open', '{}')
    `;

      yield* BosunMigrations.runMigrations(95);

      const [workflow] = yield* sql<{
        readonly name: string;
        readonly instructions: string;
        readonly leadRoleId: string;
        readonly crew: string;
      }>`
      SELECT name, instructions, lead_role_id AS leadRoleId, crew_role_ids_json AS crew
      FROM workflows WHERE id = 'workflow:feature-delivery'
    `;
      assert.strictEqual(workflow?.name, "Feature delivery");
      assert.strictEqual(workflow?.leadRoleId, "role:project-manager");
      assert.include(workflow?.instructions ?? "", "ask the person to approve the plan");
      assert.deepStrictEqual(JSON.parse(workflow!.crew).toSorted(), [
        "role:builder",
        "role:planner",
      ]);
      const [manager] = yield* sql<{ readonly text: string }>`
      SELECT instructions AS text FROM roles WHERE id = 'role:project-manager'
    `;
      assert.include(manager!.text, "Your first message names the workflow to follow");
      assert.notInclude(manager!.text, "A usual path is plan");
      const [feature] = yield* sql<{ readonly workflowId: string | null }>`
      SELECT workflow_id AS workflowId FROM features WHERE id = 'feature-one'
    `;
      assert.strictEqual(feature?.workflowId, null);

      // Epic joins it, led by the manager with the Planner and QA Tester the crew has.
      yield* BosunMigrations.runMigrations(96);
      const [epic] = yield* sql<{ readonly leadRoleId: string; readonly crew: string }>`
      SELECT lead_role_id AS leadRoleId, crew_role_ids_json AS crew
      FROM workflows WHERE id = 'workflow:epic'
    `;
      assert.strictEqual(epic?.leadRoleId, "role:project-manager");
      assert.deepStrictEqual(JSON.parse(epic!.crew), ["role:planner"]);
      const [child] = yield* sql<{ readonly parent: string | null }>`
      SELECT parent_feature_id AS parent FROM features WHERE id = 'feature-one'
    `;
      assert.strictEqual(child?.parent, null);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves a fresh install's workflow to the default roles", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    assert.deepStrictEqual(yield* sql`SELECT id FROM workflows`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
