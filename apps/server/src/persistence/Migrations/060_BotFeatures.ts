import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE bot_features (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX bot_features_project ON bot_features (project_id, created_at, id)`;
  yield* sql`
    CREATE TRIGGER bot_feature_scope BEFORE INSERT ON bots
    WHEN NEW.feature_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'Bot feature must belong to its project')
      WHERE NOT EXISTS (
        SELECT 1 FROM bot_features
        WHERE id = NEW.feature_id AND project_id = NEW.project_id
      );
    END
  `;
});
