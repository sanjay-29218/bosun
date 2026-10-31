import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const STAGE_ASK =
  "If information is missing, call crew_ask with the exact question, then continue after an answer.";
const BUILDER = `You are the Builder. Call crew_respond when finished. ${STAGE_ASK} Do not report completion solely in prose.`;
const MANAGER =
  "You manage one project's features. Stage results and questions arrive in this thread as new messages. Answer a stage's question with crew_answer, or ask whoever asked you with crew_ask and pass the answer on with crew_answer. In a workflow, decide how to handle requested changes and route the stage with crew_respond. Keep the task and context bounded.";
const EDITED = "Ask me with crew_ask before you build.";

const task = (role: string, text: string, next: object, extra: object = {}) => ({
  type: "task",
  role,
  task: text,
  next,
  ...extra,
});
const STARTER = {
  schemaVersion: 2,
  id: "feature-delivery",
  name: "Feature delivery",
  revision: 3,
  start: "plan",
  roles: { manager: { roleId: "role:project-manager", roleRevision: 2, supervisor: null } },
  steps: {
    plan: task(
      "planner",
      "Plan the feature",
      { ready: "design" },
      { gate: true, outputs: ["plan.md"] },
    ),
    design: task(
      "designer",
      "Design the feature",
      { ready: "build" },
      { gate: true, outputs: ["design.md"] },
    ),
    build: task("builder", "Build the feature", { built: "qa", design_change_requested: "design" }),
    qa: task(
      "qa",
      "Test the feature",
      { passed: "end", changes_requested: "build" },
      { limits: { changes_requested: 2 }, outputs: ["qa-report.md"] },
    ),
    end: { type: "end" },
  },
  defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
};

const migrated = (starter: object) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(88);
    yield* sql`INSERT INTO workflow_definition_heads (id, revision) VALUES ('feature-delivery', 3)`;
    yield* sql`
      INSERT INTO workflow_definition_revisions (id, revision, definition_json, created_at)
      VALUES ('feature-delivery', 3, ${JSON.stringify(starter)}, '2026-10-01')
    `;
    return sql;
  });

it.effect("retires crew handoff grants and the stock text that names them", () =>
  Effect.gen(function* () {
    const sql = yield* migrated(STARTER);
    const role = (id: string, instructions: string, tools: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, ${tools},
        '{"instanceId":"codex","model":"gpt-5"}', 'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* role("role:project-manager", MANAGER, '["crew.respond","crew.ask","crew.answer"]');
    yield* role("role:builder", BUILDER, '["crew.respond","crew.ask"]');
    yield* role("role:custom", EDITED, '["crew.respond","preview"]');
    yield* sql`
      INSERT INTO bots (
        id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode, position,
        created_at, updated_at
      ) VALUES ('social', 'Social', '{}', 'blue', 'Coordinate.', '["crew.answer","crew.workflows"]',
        'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES ('bot-handoff:workflow:a', 'builder', 'project', 'bot-run:a', ${STAGE_ASK}, 'Run',
        ${`${BUILDER}\n\nYou build feature a.`}, '["crew.respond","crew.ask"]', 1, '{}', 'auto',
        '2026-10-01')
    `;

    yield* BosunMigrations.runMigrations(89);

    const read = (table: "bots" | "roles" | "crew_runs", id: string) =>
      sql<{ readonly tools: string; readonly text: string }>`
        SELECT allowed_tools_json AS tools, instructions AS text FROM ${sql(table)}
        WHERE id = ${id}
      `.pipe(
        Effect.map(([row]) => ({
          tools: JSON.parse(row!.tools) as ReadonlyArray<string>,
          text: row!.text,
        })),
      );
    const manager = yield* read("roles", "role:project-manager");
    assert.deepStrictEqual(manager.tools, ["crew.respond", "crew.decide"]);
    assert.include(manager.text, "crew_decide");
    const builder = yield* read("roles", "role:builder");
    assert.deepStrictEqual(builder.tools, ["crew.respond"]);
    assert.include(builder.text, 'outcome "needs_input"');
    assert.deepStrictEqual(yield* read("roles", "role:custom"), {
      tools: ["crew.respond", "preview"],
      text: EDITED,
    });
    assert.deepStrictEqual((yield* read("bots", "social")).tools, [
      "crew.decide",
      "crew.workflows",
    ]);
    const run = yield* read("crew_runs", "bot-handoff:workflow:a");
    assert.deepStrictEqual(run.tools, ["crew.respond"]);
    assert.include(run.text, "You build feature a.");
    for (const text of [manager.text, builder.text, run.text]) {
      assert.notMatch(text, /crew_ask|crew_answer/);
    }
    // A run's task is its request's identity, so it keeps the text it started with.
    const [taskRow] = yield* sql<{ readonly text: string }>`
      SELECT task_text AS text FROM crew_runs WHERE id = 'bot-handoff:workflow:a'
    `;
    assert.strictEqual(taskRow!.text, STAGE_ASK);

    const [auto] = yield* sql<{ readonly revision: number; readonly json: string }>`
      SELECT h.revision, r.definition_json AS json FROM workflow_definition_heads AS h
      JOIN workflow_definition_revisions AS r ON r.id = h.id AND r.revision = h.revision
      WHERE h.id = 'feature-delivery-auto'
    `;
    assert.strictEqual(auto!.revision, 1);
    assert.deepStrictEqual(JSON.parse(auto!.json), {
      ...STARTER,
      id: "feature-delivery-auto",
      name: "Feature delivery (auto)",
      revision: 1,
      defaults: { ...STARTER.defaults, decisions: "lead" },
    });
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("adds no auto twin for an edited Feature delivery", () =>
  Effect.gen(function* () {
    const sql = yield* migrated({
      ...STARTER,
      steps: { ...STARTER.steps, plan: { ...STARTER.steps.plan, task: "Plan it my way" } },
    });

    yield* BosunMigrations.runMigrations(89);

    assert.lengthOf(
      yield* sql`SELECT 1 FROM workflow_definition_heads WHERE id = 'feature-delivery-auto'`,
      0,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
