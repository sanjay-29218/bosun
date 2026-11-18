import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const STOCK_LEAD =
  "You lead one feature's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";

const setUp = (featureManager: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(126);
    const role = (id: string, instructions: string) => sql`
      INSERT INTO roles (
        id, name, instructions, model_selection_json, enabled, revision, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, '{"instanceId":"codex","model":"gpt-5"}', 1, 2,
        '2026-11-01', '2026-11-01')
    `;
    yield* role("role:feature-manager", featureManager);
    yield* role("role:planner", "Plan it.");
    const workflow = (
      id: string,
      lead: string,
      crew: ReadonlyArray<string>,
      instructions = `Run ${id}.`,
    ) => sql`
      INSERT INTO workflows (
        id, name, instructions, lead_role_id, crew_role_ids_json, revision, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, ${lead}, ${JSON.stringify(crew)}, 1,
        '2026-11-01', '2026-11-01')
    `;
    yield* workflow("workflow:feature-delivery", "role:feature-manager", ["role:planner"]);
    yield* workflow("workflow:planned", "role:planner", ["role:feature-manager", "role:planner"]);
    // Merged, it would pass the instructions limit, so it stays as it was.
    yield* workflow("workflow:long", "role:feature-manager", [], "x".repeat(15_990));
    // A lead started before: its member and run stay, so the feature keeps running.
    yield* sql`
      INSERT INTO crew_members (
        id, project_id, role_id, role_revision, name, instructions, model_selection_json,
        enabled, revision, created_at, updated_at
      ) VALUES ('bot-manager:web', 'web', 'role:feature-manager', 2, 'Feature manager',
        ${featureManager}, '{"instanceId":"codex","model":"gpt-5"}', 1, 1, '2026-11-01',
        '2026-11-01')
    `;
    yield* BosunMigrations.runMigrations(127);
    return sql;
  });

const workflows = (sql: SqlClient.SqlClient) =>
  sql<{ readonly id: string; readonly instructions: string; readonly crew: string }>`
    SELECT id, instructions, crew_role_ids_json AS crew FROM workflows ORDER BY id
  `;

it.effect("moves an edited lead role into each workflow it led, then drops the role", () =>
  Effect.gen(function* () {
    const sql = yield* setUp("Lead with care. Always ask before pushing.");
    assert.deepStrictEqual(yield* workflows(sql), [
      {
        id: "workflow:feature-delivery",
        instructions:
          "Lead with care. Always ask before pushing.\n\nRun workflow:feature-delivery.",
        crew: '["role:planner"]',
      },
      { id: "workflow:long", instructions: "x".repeat(15_990), crew: "[]" },
      {
        id: "workflow:planned",
        instructions: "Plan it.\n\nRun workflow:planned.",
        crew: '["role:planner"]',
      },
    ]);
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('workflows')
    `;
    assert.notInclude(
      columns.map((column) => column.name),
      "lead_role_id",
    );
    assert.deepStrictEqual(yield* sql`SELECT id FROM roles ORDER BY id`, [{ id: "role:planner" }]);
    assert.deepStrictEqual(
      yield* sql`SELECT id, role_id AS roleId FROM crew_members WHERE id = 'bot-manager:web'`,
      [{ id: "bot-manager:web", roleId: null }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("leaves a workflow led by the stock Feature manager as it was", () =>
  Effect.gen(function* () {
    const sql = yield* setUp(STOCK_LEAD);
    const [delivery] = yield* workflows(sql);
    assert.strictEqual(delivery?.instructions, "Run workflow:feature-delivery.");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
