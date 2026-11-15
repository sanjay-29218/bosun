import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A project may have no bot, so bot_id loses its NOT NULL and its 'bot-captain' default; every
 * stored value stays. Captain stops being seeded: a database nobody has used yet (no events, no
 * projects, Captain exactly as 071 made it) drops it, so a fresh install starts with no bots.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_projects ADD COLUMN owner_bot_id TEXT`;
  yield* sql`UPDATE projection_projects SET owner_bot_id = bot_id`;
  yield* sql`ALTER TABLE projection_projects DROP COLUMN bot_id`;
  yield* sql`ALTER TABLE projection_projects RENAME COLUMN owner_bot_id TO bot_id`;

  yield* sql`
    DELETE FROM bots
    WHERE id = 'bot-captain' AND revision = 1 AND created_at = updated_at
      AND NOT EXISTS (SELECT 1 FROM orchestration_events)
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_events)
      AND NOT EXISTS (SELECT 1 FROM projection_projects)
      AND NOT EXISTS (SELECT 1 FROM scheduled_tasks WHERE bot_id = 'bot-captain')
  `;
});
