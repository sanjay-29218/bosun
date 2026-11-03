import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A workflow is a lead role, a crew of roles and plain instructions; a feature follows one.
 * Feature delivery takes over the crew of the roles that joined every feature, and the stock
 * project manager text loses the steps that are now that workflow's.
 */
const OLD_MANAGER =
  "You lead one project's features. A feature's brief is your first message. Run it with your crew: give a crew member a task with delegate_task, setting crewMember to their name; their result comes back here. A usual path is plan, ask the person to approve the plan, then design if it needs one, build, and QA. Skip what the work doesn't need, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the feature is done, say so and summarize what changed.";
const NEW_MANAGER =
  "You lead one project's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";
const FEATURE_DELIVERY =
  "Have the Planner plan it, then ask the person to approve the plan. Have the Designer design it if it needs one. Have the Builder build it, then the QA Tester check it and the Reviewer review the diff; send what they find back to the Builder until both pass. Then have the Builder commit, push and open the pull request. Skip what the work doesn't need.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const hasTable = (table: string) =>
    sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  yield* sql`
    CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      lead_role_id TEXT NOT NULL,
      crew_role_ids_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  if (yield* hasTable("features")) {
    const columns = yield* sql<{
      readonly name: string;
    }>`SELECT name FROM pragma_table_info('features')`;
    if (!columns.some((column) => column.name === "workflow_id")) {
      yield* sql`ALTER TABLE features ADD COLUMN workflow_id TEXT`;
    }
  }
  if (!(yield* hasTable("roles"))) return;
  // A fresh install has no roles yet; seeding the defaults makes the workflow with them.
  yield* sql`
    INSERT OR IGNORE INTO workflows
      (id, name, instructions, lead_role_id, crew_role_ids_json, revision, created_at, updated_at)
    SELECT 'workflow:feature-delivery', 'Feature delivery', ${FEATURE_DELIVERY},
      'role:project-manager',
      (SELECT json_group_array(id) FROM (
        SELECT id FROM roles
        WHERE auto_create_for_feature = 1 AND enabled = 1 AND id <> 'role:project-manager'
        ORDER BY created_at, id
      )),
      1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE EXISTS (SELECT 1 FROM roles WHERE id = 'role:project-manager')
  `;
  for (const table of ["roles", "crew_members"] as const) {
    yield* sql`
      UPDATE ${sql(table)} SET instructions = replace(instructions, ${OLD_MANAGER}, ${NEW_MANAGER})
      WHERE instr(instructions, ${OLD_MANAGER}) > 0
    `;
  }
});
