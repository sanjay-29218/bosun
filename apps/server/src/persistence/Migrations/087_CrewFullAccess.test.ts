import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const OLD_MANAGER =
  "You manage one project. Delegate implementation to the project's builder using crew_delegate and a stable request ID. Then end your turn: the builder's outcome arrives in this thread as a new message, so don't poll crew_wait_handoff for it. Report the outcome to whoever asked through crew_respond. If the builder needs a person's answer, use crew_ask; when the answer arrives, pass it to the child request using crew_answer. In a workflow, decide how to handle requested changes and route the stage with crew_respond. Keep the task and context bounded.";
const OLD_HEADQUARTERS = [
  "You run this bot's work across every project it owns. crew_list_projects shows them with each project's manager and features. Hand a project work with t3_feature_start, and start a new project with crew_create_project when you're allowed to.",
  "Feature workflows report here too, and each stage notice names its feature. The workflow sends each stage to its crew member, so never delegate stage work yourself.",
  "When the person asks to create or change a workflow or role, do it with the t3_workflow_* and t3_role_* tools if you're allowed to, then say what changed. When they ask you to start work in one of your projects on a workflow, start a feature with t3_feature_start.",
  "Tell the person only what they must decide.",
].join("\n\n");

it.effect("gives bots and crew full access and retires the crew tools thread tools replaced", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(86);
    yield* sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
        default_workflow_id, created_at, updated_at
      ) VALUES ('social', 'Social', '{}', 'blue', '', '["crew.delegate","preview"]', 'auto', 1,
        'quick-task', '2026-10-01', '2026-10-01')
    `;
    const role = (id: string, instructions: string, tools: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, ${tools},
        '{"instanceId":"codex","model":"gpt-5"}', 'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* role(
      "role:project-manager",
      OLD_MANAGER,
      '["crew.delegate","crew.respond","crew.ask","crew.status","crew.answer"]',
    );
    yield* role(
      "role:builder",
      "Build it your way.",
      '["crew.respond","crew.ask","orchestration"]',
    );
    const run = (id: string, memberId: string, taskText: string) => sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES (${id}, ${memberId}, 'project', ${`bot-run:${id}`}, ${taskText}, 'Run', '',
        '["crew.respond","worktree"]', 1, '{}', 'auto', '2026-10-01')
    `;
    yield* run("bot-hq:social", "social", OLD_HEADQUARTERS);
    yield* run("bot-hq:bot-captain", "bot-captain", "A task a person wrote");
    yield* sql`INSERT INTO workflow_definition_heads (id, revision) VALUES ('quick-task', 1)`;
    yield* sql`
      INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
      VALUES ('quick-task', 1, '{}', '2026-10-01')
    `;

    yield* BosunMigrations.runMigrations(87);

    const tools = (table: "bots" | "roles" | "crew_runs", id: string) =>
      sql<{ readonly tools: string }>`
        SELECT allowed_tools_json AS tools FROM ${sql(table)} WHERE id = ${id}
      `.pipe(Effect.map((rows) => JSON.parse(rows[0]!.tools) as ReadonlyArray<string>));
    // Captain held every grant (078); the T3 ones would now limit it, so they go.
    assert.deepStrictEqual(yield* tools("bots", "bot-captain"), [
      "crew.answer",
      "crew.ask",
      "crew.respond",
      "crew.workflows",
    ]);
    assert.deepStrictEqual(yield* tools("bots", "social"), ["crew.answer"]);
    assert.deepStrictEqual(yield* tools("roles", "role:project-manager"), [
      "crew.respond",
      "crew.ask",
      "crew.answer",
    ]);
    assert.deepStrictEqual(yield* tools("roles", "role:builder"), ["crew.respond", "crew.ask"]);
    assert.deepStrictEqual(yield* tools("crew_runs", "bot-hq:social"), ["crew.respond"]);

    const [manager] = yield* sql<{ readonly text: string }>`
      SELECT instructions AS text FROM roles WHERE id = 'role:project-manager'
    `;
    assert.notInclude(manager!.text, "crew_delegate");
    assert.strictEqual(
      (yield* sql<{ readonly text: string }>`
        SELECT instructions AS text FROM roles WHERE id = 'role:builder'
      `)[0]!.text,
      "Build it your way.",
    );
    const task = (id: string) =>
      sql<{ readonly text: string }>`SELECT task_text AS text FROM crew_runs WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]!.text),
      );
    const social = yield* task("bot-hq:social");
    assert.include(social, 'botId "social"');
    assert.include(social, "delegate_task");
    assert.notInclude(social, "crew_list_projects");
    assert.strictEqual(yield* task("bot-hq:bot-captain"), "A task a person wrote");

    const [defaults] = yield* sql<{ readonly workflowId: string | null }>`
      SELECT default_workflow_id AS workflowId FROM bots WHERE id = 'social'
    `;
    assert.isNull(defaults!.workflowId);
    assert.lengthOf(yield* sql`SELECT 1 FROM workflow_definition_heads WHERE id = 'quick-task'`, 0);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
