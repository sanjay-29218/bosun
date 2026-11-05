import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const MANAGER =
  "You lead one project's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";

it.effect("moves the feature lead role to role:feature-manager, renaming only stock text", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(94);
    const role = (id: string, name: string, instructions: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        enabled, auto_create_for_feature, revision, created_at, updated_at
      ) VALUES (${id}, ${name}, ${instructions}, '[]', '{"instanceId":"codex","model":"gpt-5"}',
        'full-access', 1, 0, 6, '2026-10-01', '2026-10-01')
    `;
    yield* role("role:project-manager", "Project manager", MANAGER);
    yield* role("role:planner", "Planner", "Plan.");
    yield* role("role:qa-tester", "QA Tester", "Test.");
    // 095 and 096 make Feature delivery and Epic from these roles.
    yield* BosunMigrations.runMigrations(100);
    yield* sql`
      INSERT INTO workflows
        (id, name, instructions, lead_role_id, crew_role_ids_json, created_at, updated_at)
      VALUES ('workflow:custom', 'Custom', 'Plan, then manage.', 'role:planner',
        '["role:project-manager","role:qa-tester"]', '2026-10-01', '2026-10-01')
    `;
    const member = (id: string, featureId: string | null, instructions: string) => sql`
      INSERT INTO crew_members (
        id, project_id, feature_id, role_id, role_revision, name, instructions,
        allowed_tools_json, model_selection_json, runtime_mode, enabled, revision,
        created_at, updated_at
      ) VALUES (${id}, 'web', ${featureId}, 'role:project-manager', 6, 'Project manager',
        ${instructions}, '[]', '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 1, 1,
        '2026-10-01', '2026-10-01')
    `;
    yield* member("bot-manager:web", null, `${MANAGER}\n\nYou manage project web.`);
    yield* member("feature:custom:role:project-manager", "custom", MANAGER);

    yield* BosunMigrations.runMigrations(101);

    assert.deepStrictEqual(
      yield* sql`SELECT id, name, instructions, revision FROM roles WHERE id LIKE '%manager'`,
      [
        {
          id: "role:feature-manager",
          name: "Feature manager",
          instructions: MANAGER.replace("one project's work", "one feature's work"),
          revision: 7,
        },
      ],
    );
    const workflows = yield* sql<{
      readonly id: string;
      readonly lead: string;
      readonly crew: string;
      readonly instructions: string;
      readonly revision: number;
    }>`
      SELECT id, lead_role_id AS lead, crew_role_ids_json AS crew, instructions, revision
      FROM workflows ORDER BY id
    `;
    assert.deepStrictEqual(
      workflows.map(({ id, lead, crew, revision }) => ({ id, lead, crew, revision })),
      [
        {
          id: "workflow:custom",
          lead: "role:planner",
          crew: '["role:feature-manager","role:qa-tester"]',
          revision: 2,
        },
        {
          id: "workflow:epic",
          lead: "role:feature-manager",
          crew: '["role:planner","role:qa-tester"]',
          revision: 3,
        },
        { id: "workflow:feature-delivery", lead: "role:feature-manager", crew: "[]", revision: 2 },
      ],
    );
    const epic = workflows.find((workflow) => workflow.id === "workflow:epic")!.instructions;
    assert.notInclude(epic, "at most two children");
    assert.include(epic, "starts only after that child reports done. Each child's lead");
    // Only the project's own lead is renamed; a feature's member keeps the name its lead uses.
    assert.deepStrictEqual(
      yield* sql`SELECT id, role_id AS roleId, name, instructions FROM crew_members ORDER BY id`,
      [
        {
          id: "bot-manager:web",
          roleId: "role:feature-manager",
          name: "Feature manager",
          instructions: `${MANAGER.replace("one project's work", "one feature's work")}\n\nYou manage project web.`,
        },
        {
          id: "feature:custom:role:project-manager",
          roleId: "role:feature-manager",
          name: "Project manager",
          instructions: MANAGER,
        },
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("keeps a renamed or rewritten role, and an edited Epic, as the person left them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 79 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(94);
    yield* sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        enabled, auto_create_for_feature, revision, created_at, updated_at
      ) VALUES ('role:project-manager', 'Lead', 'My own lead text.', '[]',
        '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 1, 0, 3, '2026-10-01', '2026-10-01'),
        ('role:planner', 'Planner', 'Plan.', '[]',
        '{"instanceId":"codex","model":"gpt-5"}', 'full-access', 1, 0, 1, '2026-10-01', '2026-10-01')
    `;
    yield* BosunMigrations.runMigrations(100);
    yield* sql`
      UPDATE workflows SET instructions = instructions || ' Keep it small.' WHERE id = 'workflow:epic'
    `;

    yield* BosunMigrations.runMigrations(101);

    assert.deepStrictEqual(
      yield* sql`SELECT id, name, instructions FROM roles WHERE id LIKE '%manager'`,
      [{ id: "role:feature-manager", name: "Lead", instructions: "My own lead text." }],
    );
    const [epic] = yield* sql<{ readonly instructions: string }>`
      SELECT instructions FROM workflows WHERE id = 'workflow:epic'
    `;
    assert.include(epic!.instructions, "Run at most two children at once.");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
