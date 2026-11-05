import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { BOT_REWRITE, HEADQUARTERS_REWRITE } from "./098_ProjectHandoffs.ts";

/*
 * Bots hand project work to the project's manager, and start a task or feature themselves only
 * when the person asks. A headquarters keeps its task text across fresh starts, so stock stored
 * text is rewritten here; edited text stays as it is.
 */
const TASK_BRIEF =
  "You do one request in this worktree. Do small work yourself, commit it, and open a pull request; never merge or force-push. When the work needs planning, design or several steps, start a feature with t3_feature_start instead, and report that it started: the feature's lead runs it with its crew. Report what you did, or the question a person must answer.";

export const BOT_HANDOFF =
  "Hand each request to its project's Project manager with t3_project_send; it replies to this thread.";

export const HEADQUARTERS_HANDOFF = `Hand each request for a project to its Project manager with t3_project_send: that projectId, the request with everything it needs to know, and a key you choose for the request (send the same key again on a retry). The Project manager picks a task, a feature or several, and replies here as the work moves. Start a task or a feature in a project yourself only when the person asks you to: a task with delegate_task, target.projectId set to that project and isolation "worktree", beginning its task with: "${TASK_BRIEF}"; a feature with t3_feature_start and that projectId. Link the thread the request went to, or the one you started, in your reply, then end your turn.`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = (table: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => rows.map((row) => row.name)),
    );
  if ((yield* columns("bots")).includes("instructions")) {
    yield* sql`
      UPDATE bots SET instructions = replace(instructions, ${BOT_REWRITE[1]}, ${BOT_HANDOFF})
      WHERE instr(instructions, ${BOT_REWRITE[1]}) > 0
    `;
  }
  // A run's task is its identity, so only headquarters runs, which are rebuilt from it, change.
  if ((yield* columns("crew_runs")).includes("task_text")) {
    yield* sql`
      UPDATE crew_runs
      SET task_text = replace(task_text, ${HEADQUARTERS_REWRITE[1]}, ${HEADQUARTERS_HANDOFF})
      WHERE id LIKE 'bot-hq:%' AND instr(task_text, ${HEADQUARTERS_REWRITE[1]}) > 0
    `;
  }
});
