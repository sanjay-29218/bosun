import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * The main rail shows only pinned bots and project managers; the Bots list shows them all.
 * Everything that exists now stays in the rail. The projector writes `manager_pinned` for every
 * project it creates, so the default only pins existing ones.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN pinned INTEGER NOT NULL DEFAULT 1`;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN manager_pinned INTEGER NOT NULL DEFAULT 1`;
});
