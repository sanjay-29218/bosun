import { assert, it } from "@effect/vitest";
import { WorkflowDefinition } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const model = JSON.stringify({ instanceId: "codex", model: "gpt-5" });
const decodeDefinition = Schema.decodeUnknownSync(Schema.fromJsonString(WorkflowDefinition));

const templateDefinition = (projectId: string, plannerRevision: number) =>
  JSON.stringify({
    schemaVersion: 1,
    id: "feature-delivery",
    name: "Feature delivery",
    revision: 1,
    start: "plan",
    bots: {
      manager: {
        template: { kind: "existing-project-bot", id: `bot-manager:${projectId}` },
        supervisor: null,
      },
      planner: {
        template: {
          kind: "template",
          id: `template:planner:${projectId}`,
          revision: plannerRevision,
        },
        supervisor: "manager",
      },
    },
    steps: {
      plan: { type: "task", bot: "planner", task: "Plan", next: { ready: "review" } },
      review: { type: "task", bot: "manager", task: "Decide", next: { done: "end" } },
      end: { type: "end" },
    },
    defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
  });

it.effect("turns per-project bot templates into global roles and workflows", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(69);

    const template = (
      id: string,
      projectId: string | null,
      name: string,
      tools: string,
      revision: number,
      updatedAt: string,
    ) => sql`
      INSERT INTO bot_templates (
        id, project_id, name, instructions, allowed_tools_json, model_selection_json,
        runtime_mode, enabled, auto_create_for_feature, revision, created_at, updated_at
      ) VALUES (
        ${id}, ${projectId}, ${name}, ${`Use bots_respond as ${name}`}, ${tools}, ${model},
        'approval-required', 1, ${name === "Manager" || name === "Captain" ? 0 : 1}, ${revision},
        '2026-10-01', ${updatedAt}
      )
    `;
    yield* template("template:captain", null, "Captain", '["bots.delegate"]', 1, "2026-10-01");
    yield* template(
      "template:manager:p1",
      "p1",
      "Manager",
      '["bots.delegate","bots.respond"]',
      1,
      "2026-10-01",
    );
    yield* template("template:planner:p1", "p1", "Planner", '["bots.respond"]', 1, "2026-10-01");
    yield* template("template:planner:p2", "p2", "Planner", '["bots.respond"]', 3, "2026-10-05");
    yield* template("bot-template:custom", "p1", "Researcher", '["bots.ask"]', 2, "2026-10-02");

    const member = (
      id: string,
      projectId: string | null,
      featureId: string | null,
      templateId: string | null,
      revision: number | null,
    ) => sql`
      INSERT INTO bots (
        id, project_id, feature_id, template_id, template_revision, name, instructions,
        allowed_tools_json, model_selection_json, runtime_mode, enabled, revision,
        created_at, updated_at
      ) VALUES (
        ${id}, ${projectId}, ${featureId}, ${templateId}, ${revision}, ${id}, 'Call bots_delegate',
        '["bots.delegate"]', ${model}, 'approval-required', 1, 1, '2026-10-01', '2026-10-01'
      )
    `;
    yield* member("bot-captain", null, null, "template:captain", 1);
    yield* member("bot-manager:p1", "p1", null, "template:manager:p1", 1);
    yield* member("feature-bot:planner", "p1", "feature-1", "template:planner:p1", 1);
    yield* sql`
      INSERT INTO bot_delegation_grants (source_bot_id, target_bot_id)
      VALUES ('bot-captain', 'bot-manager:p1'), ('bot-manager:p1', 'feature-bot:planner')
    `;
    yield* sql`UPDATE bot_hierarchy SET parent_bot_id = 'bot-captain' WHERE bot_id = 'bot-manager:p1'`;
    yield* sql`
      INSERT INTO bot_runs (
        id, bot_id, project_id, thread_id, task_text, title, instructions, allowed_tools_json,
        bot_revision, model_selection_json, runtime_mode, created_at
      ) VALUES
        ('lead', 'bot-manager:p1', 'p1', 'bot-run:lead', 'Lead', 'Lead', 'Use bots_ask',
          '["bots.delegate","bots.status"]', 1, ${model}, 'approval-required', '2026-10-01'),
        ('stage', 'feature-bot:planner', 'p1', 'bot-run:stage', 'Plan', 'Plan', 'Plan',
          '["bots.respond"]', 1, ${model}, 'approval-required', '2026-10-01')
    `;
    yield* sql`
      INSERT INTO bot_handoffs (
        id, source_run_id, target_bot_id, target_run_id, project_id, task_text, context_text,
        depth, status, created_at, updated_at
      ) VALUES ('handoff', 'lead', 'feature-bot:planner', 'stage', 'p1', 'Plan', '', 1,
        'running', '2026-10-01', '2026-10-01')
    `;
    yield* sql`
      INSERT INTO bot_handoff_receipts (handoff_id, handoff_json)
      VALUES ('handoff', ${JSON.stringify({ id: "handoff", targetBotId: "feature-bot:planner" })})
    `;

    // Both projects published the starter; p2 most recently. p1 also has its own "custom".
    for (const [projectId, revision, createdAt] of [
      ["p1", 1, "2026-10-01"],
      ["p2", 3, "2026-10-05"],
    ] as const) {
      yield* sql`
        INSERT INTO workflow_definition_heads VALUES (${projectId}, 'feature-delivery', 1)
      `;
      yield* sql`
        INSERT INTO workflow_definition_revisions VALUES
          (${projectId}, 'feature-delivery', 1, ${templateDefinition(projectId, revision)}, ${createdAt})
      `;
      yield* sql`INSERT INTO workflow_definition_heads VALUES (${projectId}, 'custom', 1)`;
      yield* sql`
        INSERT INTO workflow_definition_revisions VALUES
          (${projectId}, 'custom', 1, ${templateDefinition(projectId, revision)}, ${createdAt})
      `;
    }
    yield* sql`
      INSERT INTO features (id, project_id, title, brief, created_at, updated_at, bot_assignments_json)
      VALUES ('feature-1', 'p1', 'Feature', 'Brief', '2026-10-01', '2026-10-01',
        ${JSON.stringify({ manager: "bot-manager:p1", planner: "feature-bot:planner" })})
    `;
    yield* sql`
      INSERT INTO feature_workflows
        (feature_id, project_id, workflow_id, workflow_revision, definition_json, created_at)
      VALUES ('feature-1', 'p1', 'custom', 1, ${templateDefinition("p1", 1)}, '2026-10-01')
    `;
    yield* sql`
      INSERT INTO workflow_executions (feature_id, bindings_json) VALUES ('feature-1',
        ${JSON.stringify({ planner: { botId: "feature-bot:planner", dispatchRunId: "lead" } })})
    `;
    yield* sql`
      INSERT INTO workflow_step_events (feature_id, event_id, event_json, occurred_at)
      VALUES ('feature-1', 'started', ${JSON.stringify({ kind: "started", stepId: "plan", botRunId: "stage" })}, '2026-10-01')
    `;

    yield* BosunMigrations.runMigrations(70);

    // Each default role keeps the newest project's template; Captain is no longer a role.
    assert.deepStrictEqual(
      yield* sql`
        SELECT id, name, revision, allowed_tools_json AS tools, instructions FROM roles ORDER BY id
      `,
      [
        {
          id: "bot-template:custom",
          name: "Researcher",
          revision: 2,
          tools: '["crew.ask"]',
          instructions: "Use crew_respond as Researcher",
        },
        {
          id: "role:planner",
          name: "Planner",
          revision: 3,
          tools: '["crew.respond"]',
          instructions: "Use crew_respond as Planner",
        },
        {
          id: "role:project-manager",
          name: "Project manager",
          revision: 1,
          tools: '["crew.delegate","crew.respond"]',
          instructions: "Use crew_respond as Manager",
        },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT id, role_id AS roleId, role_revision AS roleRevision, instructions
        FROM crew_members ORDER BY id
      `,
      [
        { id: "bot-captain", roleId: null, roleRevision: null, instructions: "Call crew_delegate" },
        {
          id: "bot-manager:p1",
          roleId: "role:project-manager",
          roleRevision: 1,
          instructions: "Call crew_delegate",
        },
        {
          id: "feature-bot:planner",
          roleId: "role:planner",
          roleRevision: 1,
          instructions: "Call crew_delegate",
        },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`SELECT id, member_id AS memberId, allowed_tools_json AS tools FROM crew_runs ORDER BY id`,
      [
        { id: "lead", memberId: "bot-manager:p1", tools: '["crew.delegate","crew.status"]' },
        { id: "stage", memberId: "feature-bot:planner", tools: '["crew.respond"]' },
      ],
    );
    assert.deepStrictEqual(yield* sql`SELECT target_member_id AS target FROM crew_handoffs`, [
      { target: "feature-bot:planner" },
    ]);
    assert.deepStrictEqual(
      JSON.parse(
        (yield* sql<{
          readonly json: string;
        }>`SELECT handoff_json AS json FROM crew_handoff_receipts`)[0]!.json,
      ),
      { id: "handoff", targetMemberId: "feature-bot:planner" },
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT member_id AS memberId, parent_member_id AS parentMemberId FROM crew_hierarchy
        ORDER BY member_id
      `,
      [
        { memberId: "bot-captain", parentMemberId: null },
        { memberId: "bot-manager:p1", parentMemberId: "bot-captain" },
        { memberId: "feature-bot:planner", parentMemberId: null },
      ],
    );
    assert.deepStrictEqual(
      yield* sql`
        SELECT source_member_id AS source, target_member_id AS target FROM crew_delegation_grants
        ORDER BY source_member_id
      `,
      [
        { source: "bot-captain", target: "bot-manager:p1" },
        { source: "bot-manager:p1", target: "feature-bot:planner" },
      ],
    );
    assert.deepStrictEqual(
      JSON.parse(
        (yield* sql<{
          readonly json: string;
        }>`SELECT crew_assignments_json AS json FROM features`)[0]!.json,
      ),
      { manager: "bot-manager:p1", planner: "feature-bot:planner" },
    );
    assert.deepStrictEqual(
      JSON.parse(
        (yield* sql<{
          readonly json: string;
        }>`SELECT bindings_json AS json FROM workflow_executions`)[0]!.json,
      ),
      { planner: { dispatchRunId: "lead", memberId: "feature-bot:planner" } },
    );
    assert.deepStrictEqual(
      JSON.parse(
        (yield* sql<{
          readonly json: string;
        }>`SELECT event_json AS json FROM workflow_step_events`)[0]!.json,
      ),
      { kind: "started", stepId: "plan", runId: "stage" },
    );

    // One global library: p2's starter wins, p1's starter copy is dropped, and p1's clashing
    // "custom" keeps its history under a project-suffixed ID along with the feature using it.
    const library = yield* sql<{ readonly id: string; readonly json: string }>`
      SELECT h.id, r.definition_json AS json FROM workflow_definition_heads AS h
      JOIN workflow_definition_revisions AS r ON r.id = h.id AND r.revision = h.revision
      ORDER BY h.id
    `;
    assert.deepStrictEqual(
      library.map((row) => row.id),
      ["custom", "custom:p1", "feature-delivery"],
    );
    const starter = decodeDefinition(library.find((row) => row.id === "feature-delivery")!.json);
    assert.deepStrictEqual(starter.roles, {
      manager: { roleId: "role:project-manager", roleRevision: 1, supervisor: null },
      planner: { roleId: "role:planner", roleRevision: 3, supervisor: "manager" },
    });
    assert.strictEqual(starter.steps.plan?.type === "task" && starter.steps.plan.role, "planner");
    assert.strictEqual(
      decodeDefinition(library.find((row) => row.id === "custom:p1")!.json).id,
      "custom:p1",
    );
    const copy = (yield* sql<{ readonly workflowId: string; readonly json: string }>`
      SELECT workflow_id AS workflowId, definition_json AS json FROM feature_workflows
    `)[0]!;
    assert.strictEqual(copy.workflowId, "custom:p1");
    assert.deepStrictEqual(decodeDefinition(copy.json).roles.planner, {
      roleId: "role:planner",
      roleRevision: 1,
      supervisor: "manager",
    });

    assert.deepStrictEqual(yield* sql`PRAGMA foreign_key_check`, []);
    assert.deepStrictEqual(yield* BosunMigrations.runMigrations(70), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
