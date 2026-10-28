import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * Captain starts with full access and every tool. Only the Captain 071 seeded fresh changes
 * (never saved, created and updated together); one carried over from the crew or set up by a
 * person keeps their choices.
 */

const ALL_TOOLS =
  '["crew.delegate","crew.status","crew.answer","crew.ask","crew.respond","crew.projects",' +
  '"crew.create-project","crew.workflows","orchestration","worktree","pull-requests","preview",' +
  '"device"]';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE bots SET runtime_mode = 'full-access', allowed_tools_json = ${ALL_TOOLS}
    WHERE id = 'bot-captain' AND revision = 1 AND created_at = updated_at
  `;
});
