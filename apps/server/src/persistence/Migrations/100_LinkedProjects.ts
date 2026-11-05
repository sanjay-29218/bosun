import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { HEADQUARTERS_REWRITE as PROJECT_HANDOFFS } from "./098_ProjectHandoffs.ts";

/*
 * A bot's headquarters reaches its projects on linked environments: t3_bot_projects lists them
 * and delegate_task takes their environmentId. Stock headquarters text is rewritten; edited text
 * stays as it is.
 */
const LIST_FROM_PREFIX = `You run this bot's work across the projects it owns: the ones t3_project_list shows with botId "`;
const LIST_TO =
  "You run this bot's work across the projects it owns: t3_bot_projects lists them, here and on linked environments, each with its environmentId.";

export const HEADQUARTERS_REWRITE = [
  PROJECT_HANDOFFS[1],
  PROJECT_HANDOFFS[1]
    .replace(
      'isolation "worktree".',
      'isolation "worktree", plus target.environmentId when the project is on a linked environment.',
    )
    .replace(
      "reports here each time it stops.",
      "reports here each time it stops. A project on a linked environment gets its feature from its manager there: ask for the feature in the task.",
    ),
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('crew_runs')
  `;
  if (!columns.some((column) => column.name === "task_text")) return;
  const [from, to] = HEADQUARTERS_REWRITE;
  // A run's task is its identity, so only headquarters runs, which are rebuilt from it, change.
  yield* sql`
    UPDATE crew_runs SET task_text = replace(task_text, ${from}, ${to})
    WHERE id LIKE 'bot-hq:%' AND instr(task_text, ${from}) > 0
  `;
  yield* sql`
    UPDATE crew_runs
    SET task_text = replace(
      task_text, ${LIST_FROM_PREFIX} || substr(id, ${"bot-hq:".length + 1}) || '".', ${LIST_TO}
    )
    WHERE id LIKE 'bot-hq:%'
  `;
});
