import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * The starter Builder may split its stage into parallel subagents (delegate_task), which the
 * orchestration grant allows. The role and the builders made from it get the grant, and
 * instructions that still match the old default gain the guidance. Edited ones stay as written.
 */

const OLD_INSTRUCTIONS =
  "You are the Builder. Follow the assigned task in the linked T3 thread. Call crew_respond with a structured outcome and a concise summary when finished. If information is missing, call crew_ask with the exact question, then continue after an answer. Do not report completion solely in prose.";
const NEW_INSTRUCTIONS = `${OLD_INSTRUCTIONS} When the work splits into independent parts, run them in parallel with delegate_task, one subagent per part with a self-contained brief, and wait for them with task_status. Check and combine their results yourself before you call crew_respond.`;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["roles", "crew_members"] as const) {
    // Databases upgraded from before the crew have neither table yet.
    const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if (exists.length === 0) continue;
    const key = table === "roles" ? sql`id` : sql`role_id`;
    yield* sql`
      UPDATE ${sql(table)}
      SET allowed_tools_json = json_insert(allowed_tools_json, '$[#]', 'orchestration')
      WHERE ${key} = 'role:builder'
        AND NOT EXISTS (
          SELECT 1 FROM json_each(${sql(table)}.allowed_tools_json) WHERE value = 'orchestration'
        )
    `;
    yield* sql`
      UPDATE ${sql(table)} SET instructions = ${NEW_INSTRUCTIONS}
      WHERE ${key} = 'role:builder' AND instructions = ${OLD_INSTRUCTIONS}
    `;
  }
});
