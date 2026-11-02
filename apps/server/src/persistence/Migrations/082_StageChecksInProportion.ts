import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Several stages run at once on one machine, so the starter stage roles (and the crew members
 * made from them) ask for focused checks and tidy dev servers. Text that no longer has the
 * starter's closing sentence was edited by a person and stays as written.
 */

const CLOSING = "Do not report completion solely in prose.";
const CHECKS =
  "Keep checks in proportion: run the tests and type checks for what you changed, not whole-repo suites, unless the project's instructions require them. Reuse a dev server you already started, and stop the ones you start before you respond.";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["roles", "crew_members"] as const) {
    const exists = yield* sql`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ${table}`;
    if (exists.length === 0) continue;
    yield* sql`
      UPDATE ${sql(table)} SET instructions = replace(instructions, ${CLOSING}, ${`${CLOSING} ${CHECKS}`})
      WHERE instr(instructions, ${CLOSING}) > 0 AND instr(instructions, ${CHECKS}) = 0
    `;
  }
});
