import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A feature can be a child of the feature whose lead started it; `reported_at` marks that the
 * child has reported back to its parent's lead since it last opened. Epic, a built-in workflow,
 * splits big work into child features.
 */
const EPIC =
  "This work ships as several child features, each with its own worktree, branch, crew and pull request. Have the Planner propose the split: a short list of child features, each one reviewable pull request, saying which builds on which. Ask the person to approve the split, and revise it until they do. Then start each child with t3_feature_start, with a title and a brief that stands on its own. A child that builds on another's work sets baseBranch to that child's branch and starts only after that child reports done. Run at most two children at once. Each child's lead reports back here when it finishes, with its summary and pull request; to answer or redirect a child, use t3_thread_send to its lead's thread. When every child is in, have the QA Tester run the final integration check in this feature's worktree: merge the children's branches in order, then build and run the tests. Send what fails to the child that owns it, and check again once it reports back. Then report each child's pull request in merge order. Don't build the children's work in this feature yourself.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM pragma_table_info('features')`;
  if (columns.length > 0) {
    if (!columns.some((column) => column.name === "parent_feature_id")) {
      yield* sql`ALTER TABLE features ADD COLUMN parent_feature_id TEXT`;
    }
    if (!columns.some((column) => column.name === "reported_at")) {
      yield* sql`ALTER TABLE features ADD COLUMN reported_at TEXT`;
    }
    yield* sql`CREATE INDEX IF NOT EXISTS features_parent ON features (parent_feature_id)`;
  }
  const workflows =
    yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workflows'`;
  const roles = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'roles'`;
  if (workflows.length === 0 || roles.length === 0) return;
  // A fresh install has no roles yet; seeding the defaults makes the workflow with them.
  yield* sql`
    INSERT OR IGNORE INTO workflows
      (id, name, instructions, lead_role_id, crew_role_ids_json, revision, created_at, updated_at)
    SELECT 'workflow:epic', 'Epic', ${EPIC}, 'role:project-manager',
      (SELECT json_group_array(id) FROM (
        SELECT id FROM roles WHERE id IN ('role:planner', 'role:qa-tester') ORDER BY created_at, id
      )),
      1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'role:project-manager')
  `;
});
