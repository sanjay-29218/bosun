import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Workflows lose their lead role. A lead role someone edited moves into each workflow it led,
 * unless together they'd pass the 16,000-character instructions limit. The Feature manager role
 * goes; started leads keep their runs and members.
 */
const FEATURE_MANAGER = "role:feature-manager";
const STOCK_LEAD =
  "You lead one feature's work. Your first message names the workflow to follow, your crew, and the brief. Follow the workflow with your crew, and do small steps yourself. Ask the person when you need their decision, and wait for the answer. Keep each task bounded. When the work is done, say so and summarize what changed.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  if (!tables.has("workflows") || !tables.has("roles")) return;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('workflows')
  `;
  if (!columns.some((column) => column.name === "lead_role_id")) return;
  const [clock] = yield* sql<{ readonly now: string }>`
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now
  `;
  const now = clock?.now ?? "";

  const led = yield* sql<{
    readonly id: string;
    readonly instructions: string;
    readonly lead: string | null;
  }>`
    SELECT w.id, w.instructions, r.instructions AS lead
    FROM workflows w LEFT JOIN roles r ON r.id = w.lead_role_id
  `;
  for (const workflow of led) {
    const lead = workflow.lead?.trim() ?? "";
    const merged = `${lead}\n\n${workflow.instructions}`;
    if (lead === "" || lead === STOCK_LEAD || workflow.instructions.includes(lead)) continue;
    if (merged.length > 16_000) continue;
    yield* sql`
      UPDATE workflows SET instructions = ${merged},
        revision = revision + 1, updated_at = ${now}
      WHERE id = ${workflow.id}
    `;
  }
  yield* sql`
    UPDATE workflows SET
      crew_role_ids_json = (
        SELECT json_group_array(value) FROM json_each(workflows.crew_role_ids_json)
        WHERE value <> ${FEATURE_MANAGER}
      ),
      revision = revision + 1, updated_at = ${now}
    WHERE EXISTS (
      SELECT 1 FROM json_each(workflows.crew_role_ids_json) WHERE value = ${FEATURE_MANAGER}
    )
  `;
  yield* sql`ALTER TABLE workflows DROP COLUMN lead_role_id`;

  // `crew_members.role_id` is a foreign key, so members let go of the role first.
  if (tables.has("crew_members")) {
    yield* sql`
      UPDATE crew_members SET role_id = NULL, role_revision = NULL
      WHERE role_id = ${FEATURE_MANAGER}
    `;
  }
  yield* sql`DELETE FROM roles WHERE id = ${FEATURE_MANAGER}`;
});
