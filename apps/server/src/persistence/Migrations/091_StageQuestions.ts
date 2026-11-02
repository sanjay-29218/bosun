import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A waiting stage asks with a question on its thread, answered like any other: a person in the
 * composer or on the board, a lead with t3_pending_request. An execution remembers the question
 * it opened, so a later decision can close it. crew_decide and its grant retire, and the stock
 * manager text that named it is rewritten; edited text stays as it is.
 */

const OLD_MANAGER =
  "You manage one project's features. When a feature lets its lead decide, a stage's gate or question arrives in this thread as a new message: check the stage's work, then approve, request changes or answer with crew_decide. When a workflow gives you a stage of your own, report its outcome with crew_respond. Keep the task and context bounded.";
const NEW_MANAGER =
  "You manage one project's features. When a feature lets its lead decide, a message here names a stage's question: read it with t3_pending_request, check the stage's work, then answer it with t3_pending_request. When a workflow gives you a stage of your own, report its outcome with crew_respond. Keep the task and context bounded.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (table: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  if (yield* hasTable("workflow_executions")) {
    yield* sql`ALTER TABLE workflow_executions ADD COLUMN question_thread_id TEXT`;
    yield* sql`ALTER TABLE workflow_executions ADD COLUMN question_request_id TEXT`;
    yield* sql`
      CREATE INDEX workflow_executions_question ON workflow_executions (question_request_id)
    `;
  }

  for (const table of ["bots", "roles", "crew_members", "crew_runs"] as const) {
    if (!(yield* hasTable(table))) continue;
    yield* sql`
      UPDATE ${sql(table)} SET allowed_tools_json = (
        SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(${sql(table)}.allowed_tools_json)
          WHERE value <> 'crew.decide' ORDER BY key
        )
      )
      WHERE json_valid(allowed_tools_json) AND EXISTS (
        SELECT 1 FROM json_each(${sql(table)}.allowed_tools_json) WHERE value = 'crew.decide'
      )
    `;
    yield* sql`
      UPDATE ${sql(table)} SET instructions = replace(instructions, ${OLD_MANAGER}, ${NEW_MANAGER})
      WHERE instr(instructions, ${OLD_MANAGER}) > 0
    `;
  }
});
