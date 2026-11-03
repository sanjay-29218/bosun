import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Features run as a lead with a crew: the lead gets the brief and hands work to crew members
 * with delegate_task, so the workflow engine and its tables retire. Stock role, member and run
 * text that described stages and workflows is rewritten; edited text stays as it is.
 */
const REWRITES: ReadonlyArray<readonly [string, string]> = [
  [
    '. Follow the assigned task in the linked T3 thread. Call crew_respond with a structured outcome and a concise summary when finished. If information is missing, call crew_respond with outcome "needs_input" and the exact question as the summary, then end your turn; the answer arrives in this thread. Do not report completion solely in prose. Keep checks in proportion: run the tests and type checks for what you changed, not whole-repo suites, unless the project\'s instructions require them. Reuse a dev server you already started, and stop the ones you start before you respond.',
    " on a feature's crew. Its lead gives you a task: do it in this thread's checkout, then end with a clear summary of the result and its evidence; that message goes back to the lead. If information is missing, say exactly what you need in that message instead of guessing. Keep checks in proportion: run the tests and type checks for what you changed, not whole-repo suites, unless the project's instructions require them. Reuse a dev server you already started, and stop the ones you start before you finish.",
  ],
  [
    "You manage one project's features. When a feature lets its lead decide, a message here names a stage's question: read it with t3_pending_request, check the stage's work, then answer it with t3_pending_request. When a workflow gives you a stage of your own, report its outcome with crew_respond. Keep the task and context bounded.",
    "You lead one project's features. A feature's brief is your first message. Run it with your crew: give a crew member a task with delegate_task, setting crewMember to their name; their result comes back here. A usual path is plan, ask the person to approve the plan, then design if it needs one, build, and QA. Skip what the work doesn't need, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the feature is done, say so and summarize what changed.",
  ],
  [
    "Feature workflows report here too, and each stage notice names its feature. The workflow sends each stage to its crew member, so never delegate stage work yourself.\n\n",
    "",
  ],
  [
    "When the person asks to create or change a workflow or role, do it with the t3_workflow_* and t3_role_* tools if you're allowed to, then say what changed. When they ask for a project's work to run on a workflow, name it in the project manager's task.",
    "When the person asks to create or change a role, do it with the t3_role_* tools if you're allowed to, then say what changed.",
  ],
  [
    "When the work needs planning, design or several stages, start a feature with t3_feature_start instead (t3_workflow_list shows the workflows), and report that it started.",
    "When the work needs planning, design or several steps, start a feature with t3_feature_start instead, and report that it started: the feature's lead runs it with its crew.",
  ],
];

const ENGINE_TABLES = [
  "crew_stage_threads",
  "workflow_stage_handoffs",
  "workflow_executions",
  "workflow_step_events",
  "feature_workflows",
  "workflow_definition_revisions",
  "workflow_definition_heads",
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (table: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  const hasColumn = (table: string, column: string) =>
    sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
      Effect.map((rows) => rows.some((row) => row.name === column)),
    );
  for (const table of ENGINE_TABLES) yield* sql`DROP TABLE IF EXISTS ${sql(table)}`;
  if ((yield* hasTable("bots")) && (yield* hasColumn("bots", "default_workflow_id"))) {
    yield* sql`ALTER TABLE bots DROP COLUMN default_workflow_id`;
  }
  for (const table of ["bots", "roles", "crew_members", "crew_runs"] as const) {
    if (!(yield* hasTable(table))) continue;
    yield* sql`
      UPDATE ${sql(table)} SET allowed_tools_json = (
        SELECT json_group_array(value) FROM (
          SELECT value FROM json_each(${sql(table)}.allowed_tools_json)
          WHERE value <> 'crew.respond' ORDER BY key
        )
      )
      WHERE json_valid(allowed_tools_json) AND EXISTS (
        SELECT 1 FROM json_each(${sql(table)}.allowed_tools_json) WHERE value = 'crew.respond'
      )
    `;
    for (const [from, to] of REWRITES) {
      yield* sql`
        UPDATE ${sql(table)} SET instructions = replace(instructions, ${from}, ${to})
        WHERE instr(instructions, ${from}) > 0
      `;
    }
  }
  // A run's task is its identity, so only headquarters runs, which are rebuilt from it, change.
  if (yield* hasTable("crew_runs")) {
    for (const [from, to] of REWRITES) {
      yield* sql`
        UPDATE crew_runs SET task_text = replace(task_text, ${from}, ${to})
        WHERE id LIKE 'bot-hq:%' AND instr(task_text, ${from}) > 0
      `;
    }
  }
});
