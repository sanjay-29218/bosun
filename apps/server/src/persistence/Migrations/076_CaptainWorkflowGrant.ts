import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Captain sets up workflows and roles when asked. Other bots get it when a person allows it.
 */

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE bots SET allowed_tools_json = json_insert(allowed_tools_json, '$[#]', 'crew.workflows')
    WHERE id = 'bot-captain'
      AND NOT EXISTS (
        SELECT 1 FROM json_each(bots.allowed_tools_json) WHERE value = 'crew.workflows'
      )
  `;
});
