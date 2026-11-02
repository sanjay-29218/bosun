import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as BosunMigrations from "../BosunMigrations.ts";
import { runMigrations } from "../Migrations.ts";

const CHECKS =
  "Keep checks in proportion: run the tests and type checks for what you changed, not whole-repo suites, unless the project's instructions require them. Reuse a dev server you already started, and stop the ones you start before you respond.";
const PARALLEL =
  "When the work splits into independent parts, run them in parallel with delegate_task, one subagent per part with a self-contained brief, and wait for them with task_status. Check and combine their results yourself before you call crew_respond.";

it.effect("keeps the starter Builder to one workspace and lets the Planner split work", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 69 });
    yield* BosunMigrations.reconcileLegacyHistory();
    yield* BosunMigrations.runMigrations(83);
    const role = (id: string, instructions: string) => sql`
      INSERT INTO roles (
        id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
        auto_create_for_feature, created_at, updated_at
      ) VALUES (${id}, ${id}, ${instructions}, '["crew.respond"]',
        '{"instanceId":"codex","model":"gpt-5"}', 'auto', 1, '2026-10-01', '2026-10-01')
    `;
    yield* role("role:builder", `You are the Builder. ${CHECKS} ${PARALLEL}`);
    yield* role("role:planner", `You are the Planner. ${CHECKS}`);
    yield* role("role:reviewer", `You are the Reviewer. ${CHECKS}`);

    yield* BosunMigrations.runMigrations(84);

    const text = (id: string) =>
      sql<{ readonly text: string }>`SELECT instructions AS text FROM roles WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]!.text),
      );
    const builder = yield* text("role:builder");
    assert.notInclude(builder, "run them in parallel");
    assert.include(builder, "don't create worktrees");
    assert.include(yield* text("role:planner"), "separate features");
    assert.strictEqual(yield* text("role:reviewer"), `You are the Reviewer. ${CHECKS}`);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
