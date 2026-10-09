import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_hierarchy (
      bot_id TEXT PRIMARY KEY REFERENCES bots(id),
      parent_bot_id TEXT REFERENCES bots(id),
      position INTEGER NOT NULL DEFAULT 0,
      CHECK (bot_id <> parent_bot_id)
    )
  `;
  yield* sql`CREATE INDEX bot_hierarchy_parent ON bot_hierarchy (parent_bot_id, position, bot_id)`;
  yield* sql`
    CREATE TRIGGER bot_hierarchy_new_bot AFTER INSERT ON bots
    BEGIN
      INSERT INTO bot_hierarchy (bot_id, parent_bot_id) VALUES (NEW.id, NULL);
    END
  `;
  yield* sql`
    INSERT INTO bot_hierarchy (bot_id, parent_bot_id)
    SELECT id, NULL FROM bots
  `;
  yield* sql`
    UPDATE bot_hierarchy SET parent_bot_id = 'bot-captain'
    WHERE bot_id IN (
      SELECT id FROM bots WHERE id = 'bot-manager:' || project_id
    ) AND EXISTS (SELECT 1 FROM bots WHERE id = 'bot-captain')
  `;
  yield* sql`
    UPDATE bot_hierarchy SET parent_bot_id = 'bot-manager:' || (
      SELECT project_id FROM bots WHERE bots.id = bot_hierarchy.bot_id
    )
    WHERE bot_id IN (
      SELECT id FROM bots WHERE id = 'bot-builder:' || project_id
    ) AND EXISTS (
      SELECT 1 FROM bots AS manager
      WHERE manager.id = 'bot-manager:' || (
        SELECT project_id FROM bots WHERE bots.id = bot_hierarchy.bot_id
      )
    )
  `;
});
