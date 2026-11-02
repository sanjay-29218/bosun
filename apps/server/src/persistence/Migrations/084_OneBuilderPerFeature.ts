import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A feature has one workspace and one builder. The starter Builder stops splitting its stage
 * into parallel subagents and works where its thread does; the starter Planner proposes
 * separate features for work too big for one builder. Text a person rewrote stays as written.
 */

const PARALLEL =
  "When the work splits into independent parts, run them in parallel with delegate_task, one subagent per part with a self-contained brief, and wait for them with task_status. Check and combine their results yourself before you call crew_respond.";
const BUILDER_WORKSPACE =
  "Work in this thread's workspace, and don't create worktrees or other checkouts. If it's a fresh worktree, install dependencies the way the project's instructions say before you build. Do the building yourself; use delegate_task subagents only for read-only work, such as research or reviewing your diff.";
const CHECKS =
  "Keep checks in proportion: run the tests and type checks for what you changed, not whole-repo suites, unless the project's instructions require them. Reuse a dev server you already started, and stop the ones you start before you respond.";
const PLANNER_SPLIT =
  "If the work is too big for one builder, say so in your plan and propose splitting it into separate features, each with its own branch and pull request.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["roles", "crew_members"] as const) {
    const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if (exists.length === 0) continue;
    const key = table === "roles" ? sql`id` : sql`role_id`;
    yield* sql`
      UPDATE ${sql(table)} SET instructions = replace(instructions, ${PARALLEL}, ${BUILDER_WORKSPACE})
      WHERE ${key} = 'role:builder' AND instr(instructions, ${PARALLEL}) > 0
    `;
    yield* sql`
      UPDATE ${sql(table)} SET instructions = replace(instructions, ${CHECKS}, ${`${CHECKS} ${PLANNER_SPLIT}`})
      WHERE ${key} = 'role:planner' AND instr(instructions, ${CHECKS}) > 0
        AND instr(instructions, ${PLANNER_SPLIT}) = 0
    `;
  }
});
