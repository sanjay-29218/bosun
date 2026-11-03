import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const CHECKS =
  "Keep checks in proportion: run the tests and type checks for what you changed, not whole-repo suites, unless the project's instructions require them. Reuse a dev server you already started, and stop the ones you start before you respond.";
const BUILDER = `You are the Builder. Follow the assigned task in the linked T3 thread. Call crew_respond with a structured outcome and a concise summary when finished. If information is missing, call crew_respond with outcome "needs_input" and the exact question as the summary, then end your turn; the answer arrives in this thread. Do not report completion solely in prose. ${CHECKS} Work in this thread's workspace.`;
const MANAGER =
  "You manage one project's features. When a feature lets its lead decide, a message here names a stage's question: read it with t3_pending_request, check the stage's work, then answer it with t3_pending_request. When a workflow gives you a stage of your own, report its outcome with crew_respond. Keep the task and context bounded.";
const HEADQUARTERS = [
  "You run this bot's work.",
  "Feature workflows report here too, and each stage notice names its feature. The workflow sends each stage to its crew member, so never delegate stage work yourself.",
  "Tell the person only what they must decide.",
].join("\n\n");
const EDITED = "Report with crew_respond when you are done.";

it.effect("retires the workflow engine and rewrites the stock stage and lead text", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(92);
    const role = (id: string, instructions: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, '["crew.respond","preview"]',
        '{"instanceId":"codex","model":"gpt-5"}', 'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* role("role:project-manager", MANAGER);
    yield* role("role:builder", BUILDER);
    yield* role("role:custom", EDITED);
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES ('bot-hq:captain', 'captain', 'project', 'bot-run:hq', ${HEADQUARTERS}, 'Captain',
        'Coordinate.', '["crew.respond"]', 1, '{}', 'auto', '2026-10-01')
    `;

    yield* BosunMigrations.runMigrations(93);

    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
        AND (name LIKE 'workflow_%' OR name IN ('feature_workflows', 'crew_stage_threads'))
    `;
    assert.deepStrictEqual(tables, []);
    const botColumns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info('bots') WHERE name = 'default_workflow_id'
    `;
    assert.deepStrictEqual(botColumns, []);
    const read = (id: string) =>
      sql<{ readonly tools: string; readonly text: string }>`
        SELECT allowed_tools_json AS tools, instructions AS text FROM roles WHERE id = ${id}
      `.pipe(Effect.map(([row]) => ({ tools: JSON.parse(row!.tools), text: row!.text })));
    const manager = yield* read("role:project-manager");
    assert.include(manager.text, "setting crewMember to their name");
    assert.deepStrictEqual(manager.tools, ["preview"]);
    const builder = yield* read("role:builder");
    assert.include(builder.text, "You are the Builder on a feature's crew.");
    assert.include(builder.text, "Work in this thread's workspace.");
    assert.notInclude(builder.text, "crew_respond");
    // Text a person wrote stays, even when it names a retired tool.
    assert.strictEqual((yield* read("role:custom")).text, EDITED);
    const [headquarters] = yield* sql<{ readonly task: string; readonly tools: string }>`
      SELECT task_text AS task, allowed_tools_json AS tools FROM crew_runs
      WHERE id = 'bot-hq:captain'
    `;
    assert.strictEqual(
      headquarters!.task,
      "You run this bot's work.\n\nTell the person only what they must decide.",
    );
    assert.deepStrictEqual(JSON.parse(headquarters!.tools), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
