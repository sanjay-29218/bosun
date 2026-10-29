import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A lead that delegates ends its turn and is woken by the handoff's outcome, rather than
 * polling crew_wait_handoff. Captain and the project manager role (and the managers made from
 * it) drop the polling sentence wherever it still appears; the rest of their text stays as is.
 */

const REWRITES = [
  {
    table: "bots",
    key: "id",
    id: "bot-captain",
    from: "Use crew_wait_handoff until the project manager reports a completed, failed, or needs-input outcome.",
    to: "Then end your turn: the project manager's completed, failed, or needs-input outcome arrives in this thread as a new message, so don't poll crew_wait_handoff for it.",
  },
  ...(["roles", "crew_members"] as const).map((table) => ({
    table,
    key: table === "roles" ? "id" : "role_id",
    id: "role:project-manager",
    from: "Use crew_wait_handoff for its structured outcome.",
    to: "Then end your turn: the builder's outcome arrives in this thread as a new message, so don't poll crew_wait_handoff for it.",
  })),
];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const { table, key, id, from, to } of REWRITES) {
    const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if (exists.length === 0) continue;
    yield* sql`
      UPDATE ${sql(table)} SET instructions = replace(instructions, ${from}, ${to})
      WHERE ${sql(key)} = ${id} AND instr(instructions, ${from}) > 0
    `;
  }
});
