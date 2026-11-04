import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A bot hands a project a task or a feature, and both run as that project's threads. A feature
 * remembers the thread that started it, which hears from its lead. Stock bot and headquarters
 * text that offered only delegate_task is rewritten; edited text stays as it is.
 */
const PROJECT_MANAGER_BRIEF =
  "You are this project's manager for one request. Do small work yourself in this worktree, commit it, and open a pull request; never merge or force-push. When the work needs planning, design or several steps, start a feature with t3_feature_start instead, and report that it started: the feature's lead runs it with its crew. Report what you did, or the question a person must answer.";

export const BOT_REWRITE = [
  "Hand each request to its project with delegate_task; its result comes back to this thread.",
  "Hand each request to its project, as a task with delegate_task or a feature with t3_feature_start; its result comes back to this thread.",
] as const;

export const HEADQUARTERS_REWRITE = [
  `Hand each request to its project with delegate_task: target.projectId set to that project and isolation "worktree". That child is the request's project manager, fresh for each request. Begin its task with: "${PROJECT_MANAGER_BRIEF}" Then the request, with everything the manager needs to know. Then end your turn; its result wakes you.`,
  `Hand each request to its project, where it runs as one of that project's threads and its result wakes you. For small, clear work, start a task: delegate_task with target.projectId set to that project and isolation "worktree". Begin its task with: "${PROJECT_MANAGER_BRIEF}" Then the request, with everything the manager needs to know. For work that needs planning, design or several steps, or when the person asks for a feature, start one with t3_feature_start and that projectId: its lead runs it with its crew and reports here each time it stops. Link the thread you started in your reply, then end your turn.`,
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (table: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => rows.map((row) => row.name)),
    );
  const features = yield* columns("features");
  if (features.length > 0 && !features.includes("requester_thread_id")) {
    yield* sql`ALTER TABLE features ADD COLUMN requester_thread_id TEXT`;
  }
  if ((yield* columns("bots")).includes("instructions")) {
    const [from, to] = BOT_REWRITE;
    yield* sql`
      UPDATE bots SET instructions = replace(instructions, ${from}, ${to})
      WHERE instr(instructions, ${from}) > 0
    `;
  }
  // A run's task is its identity, so only headquarters runs, which are rebuilt from it, change.
  if ((yield* columns("crew_runs")).includes("task_text")) {
    const [from, to] = HEADQUARTERS_REWRITE;
    yield* sql`
      UPDATE crew_runs SET task_text = replace(task_text, ${from}, ${to})
      WHERE id LIKE 'bot-hq:%' AND instr(task_text, ${from}) > 0
    `;
  }
});
