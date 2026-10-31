import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Crew get every T3 tool a thread gets, and a T3 toolkit grant now limits, so saved grants go
 * with those for crew tools thread tools replaced. Quick task retires: a bot hands each request
 * to a fresh project manager. Features on it keep their copy; edited text stays as written.
 */

const DROPPED = [
  "crew.delegate",
  "crew.status",
  "crew.projects",
  "crew.create-project",
  "orchestration",
  "worktree",
  "pull-requests",
  "preview",
  "device",
];

const OLD_MANAGER =
  "You manage one project. Delegate implementation to the project's builder using crew_delegate and a stable request ID. Then end your turn: the builder's outcome arrives in this thread as a new message, so don't poll crew_wait_handoff for it. Report the outcome to whoever asked through crew_respond. If the builder needs a person's answer, use crew_ask; when the answer arrives, pass it to the child request using crew_answer. In a workflow, decide how to handle requested changes and route the stage with crew_respond. Keep the task and context bounded.";
const NEW_MANAGER =
  "You manage one project's features. Stage results and questions arrive in this thread as new messages. Answer a stage's question with crew_answer, or ask whoever asked you with crew_ask and pass the answer on with crew_answer. In a workflow, decide how to handle requested changes and route the stage with crew_respond. Keep the task and context bounded.";

const OLD_HEADQUARTERS = [
  "You run this bot's work across every project it owns. crew_list_projects shows them with each project's manager and features. Hand a project work with t3_feature_start, and start a new project with crew_create_project when you're allowed to.",
  "Feature workflows report here too, and each stage notice names its feature. The workflow sends each stage to its crew member, so never delegate stage work yourself.",
  "When the person asks to create or change a workflow or role, do it with the t3_workflow_* and t3_role_* tools if you're allowed to, then say what changed. When they ask you to start work in one of your projects on a workflow, start a feature with t3_feature_start.",
  "Tell the person only what they must decide.",
].join("\n\n");
const PROJECT_MANAGER_BRIEF =
  "You are this project's manager for one request. Do small work yourself in this worktree, commit it, and open a pull request; never merge or force-push. When the work needs planning, design or several stages, start a feature with t3_feature_start instead (t3_workflow_list shows the workflows), and report that it started. Report what you did, or the question a person must answer.";
const newHeadquarters = (botId: string) =>
  [
    `You run this bot's work across the projects it owns: the ones t3_project_list shows with botId "${botId}".`,
    `Hand each request to its project with delegate_task: target.projectId set to that project and isolation "worktree". That child is the request's project manager, fresh for each request. Begin its task with: "${PROJECT_MANAGER_BRIEF}" Then the request, with everything the manager needs to know. Then end your turn; its result wakes you.`,
    `Start a new project with t3_project_create, or t3_project_clone then t3_project_create, with botId "${botId}".`,
    "Feature workflows report here too, and each stage notice names its feature. The workflow sends each stage to its crew member, so never delegate stage work yourself.",
    "When the person asks to create or change a workflow or role, do it with the t3_workflow_* and t3_role_* tools if you're allowed to, then say what changed. When they ask for a project's work to run on a workflow, name it in the project manager's task.",
    "Tell the person only what they must decide.",
  ].join("\n\n");

const QUICK_TASK = "quick-task";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (table: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );

  for (const table of ["bots", "roles", "crew_members", "crew_runs"] as const) {
    // Databases upgraded from before the crew have none of these yet.
    if (!(yield* hasTable(table))) continue;
    yield* sql`
      UPDATE ${sql(table)} SET allowed_tools_json = (
        SELECT json_group_array(value) FROM json_each(${sql(table)}.allowed_tools_json)
        WHERE value NOT IN ${sql.in(DROPPED)}
      )
      WHERE json_valid(allowed_tools_json)
    `;
  }
  if (!(yield* hasTable("bots"))) return;

  yield* sql`
    UPDATE bots SET allowed_tools_json = json_insert(allowed_tools_json, '$[#]', 'crew.answer')
    WHERE json_valid(allowed_tools_json)
      AND NOT EXISTS (SELECT 1 FROM json_each(bots.allowed_tools_json) WHERE value = 'crew.answer')
  `;
  yield* sql`UPDATE bots SET default_workflow_id = NULL WHERE default_workflow_id = ${QUICK_TASK}`;

  for (const table of ["roles", "crew_members"] as const) {
    if (!(yield* hasTable(table))) continue;
    yield* sql`
      UPDATE ${sql(table)} SET instructions = ${NEW_MANAGER}
      WHERE instructions = ${OLD_MANAGER}
    `;
  }

  if (yield* hasTable("crew_runs")) {
    const headquarters = yield* sql<{ readonly id: string; readonly botId: string }>`
      SELECT id, member_id AS botId FROM crew_runs
      WHERE id LIKE 'bot-hq:%' AND task_text = ${OLD_HEADQUARTERS}
    `;
    for (const run of headquarters) {
      yield* sql`UPDATE crew_runs SET task_text = ${newHeadquarters(run.botId)} WHERE id = ${run.id}`;
    }
  }

  if (yield* hasTable("workflow_definition_heads")) {
    yield* sql`DELETE FROM workflow_definition_revisions WHERE id = ${QUICK_TASK}`;
    yield* sql`DELETE FROM workflow_definition_heads WHERE id = ${QUICK_TASK}`;
  }
});
