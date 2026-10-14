import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Bots oversee their projects from one headquarters thread. Bots that can delegate also get to
 * see their projects and answer what they handed off; creating projects stays opt-in.
 */

const GRANTS = ["crew.answer", "crew.projects"];

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const grant of GRANTS) {
    yield* sql`
      UPDATE bots SET allowed_tools_json = json_insert(allowed_tools_json, '$[#]', ${grant})
      WHERE EXISTS (SELECT 1 FROM json_each(bots.allowed_tools_json) WHERE value = 'crew.delegate')
        AND NOT EXISTS (SELECT 1 FROM json_each(bots.allowed_tools_json) WHERE value = ${grant})
    `;
  }
});
