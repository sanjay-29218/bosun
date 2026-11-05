import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * The role that leads one feature becomes the Feature manager, under its own ID, so
 * `role:project-manager` is free for a role that manages a whole project. Names and text change
 * only where they are still stock; member and run IDs stay.
 */
const OLD_ID = "role:project-manager";
const NEW_ID = "role:feature-manager";
const OLD_NAME = "Project manager";
const NEW_NAME = "Feature manager";
const OLD_INSTRUCTIONS =
  "You lead one project's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";
const NEW_INSTRUCTIONS =
  "You lead one feature's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";
const EPIC_LIMIT = " Run at most two children at once.";
const OLD_EPIC =
  "This work ships as several child features, each with its own worktree, branch, crew and pull request. Have the Planner propose the split: a short list of child features, each one reviewable pull request, saying which builds on which. Ask the person to approve the split, and revise it until they do. Then start each child with t3_feature_start, with a title and a brief that stands on its own. A child that builds on another's work sets baseBranch to that child's branch and starts only after that child reports done. Run at most two children at once. Each child's lead reports back here when it finishes, with its summary and pull request; to answer or redirect a child, use t3_thread_send to its lead's thread. When every child is in, have the QA Tester run the final integration check in this feature's worktree: merge the children's branches in order, then build and run the tests. Send what fails to the child that owns it, and check again once it reports back. Then report each child's pull request in merge order. Don't build the children's work in this feature yourself.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  if (!tables.has("roles")) return;
  const [clock] = yield* sql<{ readonly now: string }>`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now
  `;
  const now = clock?.now ?? "";

  if (tables.has("workflows")) {
    yield* sql`
      UPDATE workflows SET
        instructions = replace(instructions, ${EPIC_LIMIT}, ''),
        revision = revision + 1, updated_at = ${now}
      WHERE id = 'workflow:epic' AND instructions = ${OLD_EPIC}
    `;
    yield* sql`
      UPDATE workflows SET lead_role_id = ${NEW_ID}, revision = revision + 1, updated_at = ${now}
      WHERE lead_role_id = ${OLD_ID}
    `;
    yield* sql`
      UPDATE workflows SET
        crew_role_ids_json = (
          SELECT json_group_array(CASE WHEN value = ${OLD_ID} THEN ${NEW_ID} ELSE value END)
          FROM json_each(workflows.crew_role_ids_json)
        ),
        revision = revision + 1, updated_at = ${now}
      WHERE EXISTS (SELECT 1 FROM json_each(workflows.crew_role_ids_json) WHERE value = ${OLD_ID})
    `;
  }

  if ((yield* sql`SELECT 1 FROM roles WHERE id = ${OLD_ID}`).length === 0) return;
  // The FK on crew_members.role_id keeps every member off the old ID once its row is gone,
  // feature-scoped members included; those keep their names, so delegation by name still works.
  yield* sql`
    INSERT OR IGNORE INTO roles (
      id, name, instructions, allowed_tools_json, model_selection_json, runtime_mode,
      enabled, auto_create_for_feature, revision, created_at, updated_at
    )
    SELECT ${NEW_ID},
      CASE WHEN name = ${OLD_NAME} THEN ${NEW_NAME} ELSE name END,
      CASE WHEN instructions = ${OLD_INSTRUCTIONS} THEN ${NEW_INSTRUCTIONS} ELSE instructions END,
      allowed_tools_json, model_selection_json, runtime_mode, enabled, auto_create_for_feature,
      revision + 1, created_at, ${now}
    FROM roles WHERE id = ${OLD_ID}
  `;
  yield* sql`
    UPDATE crew_members SET
      name = CASE WHEN name = ${OLD_NAME} THEN ${NEW_NAME} ELSE name END,
      instructions = CASE
        WHEN substr(instructions, 1, ${OLD_INSTRUCTIONS.length}) = ${OLD_INSTRUCTIONS}
          THEN ${NEW_INSTRUCTIONS} || substr(instructions, ${OLD_INSTRUCTIONS.length + 1})
        ELSE instructions
      END
    WHERE role_id = ${OLD_ID} AND id LIKE 'bot-manager:%'
  `;
  yield* sql`UPDATE crew_members SET role_id = ${NEW_ID} WHERE role_id = ${OLD_ID}`;
  yield* sql`DELETE FROM roles WHERE id = ${OLD_ID}`;
});
