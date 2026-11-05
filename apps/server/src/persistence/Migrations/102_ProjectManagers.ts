import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Each project gets a standing manager made from a new "Project manager" role, and it keeps a
 * long conversation the way a bot's headquarters does. Installs with starter roles get the role
 * here, on the Feature manager's model; `ensureDefaults` only runs from "Add starter roles".
 */
const INSTRUCTIONS = [
  "You manage one project for the bot that owns it and the person behind that bot. This thread lives as long as the project, so keep what matters in records (issues, tickets and features), not only in this conversation.",
  "A request reaches you as a message headed with its request ID. Check the backlog with crew_list_issues, and when no issue or ticket tracks the request, create one with crew_create_todo. Then decide how the work runs:\n- A task, for one clear change in a few files with no open product or design question and no plan to review, such as a copy fix, a config bump or a small bug with an obvious cause: delegate_task in a worktree, with its issue.\n- A feature, for one reviewable pull request that benefits from a plan, design, QA or review, or anything the person calls a feature: t3_feature_start, with its issue.\n- Several features, for work that needs more than one reviewable pull request: several areas or surfaces, parts that depend on each other, a shared schema or contract the other parts build on, or a check across parts. When the parts are clear and mostly independent, start each part as a feature yourself. When the split needs planning, start one feature on the Epic workflow, whose lead plans the split and starts the parts.\nWhen unsure, start smaller: a task can be redone as a feature, and a feature's Planner can propose a split.",
  "Run work in parallel only when the pieces touch different files and packages, don't depend on each other and can merge in any order. Run them one after another, or stack one on another's branch with baseBranch, when they edit the same files, change a shared contract or schema, add database migrations, or one needs another's API or decision. Before you start something, look at what is running: t3_feature_list, and what each open branch changes (git diff --name-only <base>...<branch> from this checkout). Prefer waiting to a likely merge conflict.",
  "When a feature's lead asks a question, answer it yourself with t3_pending_request when the brief, the issue, the repo's docs or an earlier decision settle it. Ask the bot that sent the request about product or taste decisions, scope changes, conflicting requirements, credentials or money, and anything destructive or public, such as publishing, deleting data or force-pushing. Permission approvals stay with the person.",
  "Reply to a request with t3_project_reply when its work starts, when you need an answer, and when it is done (done: true); t3_project_requests lists the open ones. Messages from the server, such as a feature's report, carry no request and need no reply.",
  "Read this project's code and git state, but never edit, commit or push in this checkout: tasks and features do the work in their own worktrees. Merge a pull request only when the request or these instructions say to.",
].join("\n\n");

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('crew_members')`;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "long_conversation")) {
    yield* sql`
      ALTER TABLE crew_members ADD COLUMN long_conversation TEXT NOT NULL DEFAULT 'compact'
        CHECK (long_conversation IN ('compact', 'new-session'))
    `;
  }
  yield* sql`
    INSERT OR IGNORE INTO roles (
      id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
      enabled, auto_create_for_feature, revision, created_at, updated_at
    )
    SELECT 'role:project-manager', 'Project manager', ${INSTRUCTIONS}, '[]',
      model_selection_json, runtime_mode, 1, 0, 1,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM roles WHERE id = 'role:feature-manager'
  `;
});
