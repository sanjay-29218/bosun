import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const legacy = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'bosun_bot_definitions'
  `;

  if (legacy.length > 0) {
    yield* sql`ALTER TABLE bosun_bot_definitions RENAME TO bot_definitions`;
    yield* sql`ALTER TABLE bosun_bot_runs RENAME TO bot_runs`;
    const handoffs = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'bosun_bot_handoffs'
    `;
    if (handoffs.length > 0) {
      yield* sql`ALTER TABLE bosun_bot_handoffs RENAME TO bot_handoffs`;
      yield* sql`DROP INDEX bosun_bot_handoffs_source`;
      yield* sql`DROP INDEX bosun_bot_handoffs_pending`;
      yield* sql`CREATE INDEX bot_handoffs_source ON bot_handoffs (source_run_id, created_at)`;
      yield* sql`CREATE INDEX bot_handoffs_pending ON bot_handoffs (status, created_at)`;
    }
    yield* sql`DROP INDEX bosun_bot_runs_pending`;
    yield* sql`DROP INDEX bosun_bot_runs_started`;
    yield* sql`
      CREATE INDEX bot_runs_pending ON bot_runs (created_at, id)
      WHERE dispatch_state = 'queued'
    `;
    yield* sql`
      CREATE INDEX bot_runs_started ON bot_runs (id)
      WHERE dispatch_state = 'started'
    `;
  }

  yield* sql`
    UPDATE bosun_sql_migrations SET name = 'Bots'
    WHERE migration_id = 55 AND name = 'BosunBots'
  `;
  yield* sql`
    UPDATE bosun_sql_migrations SET name = 'BotHandoffs'
    WHERE migration_id = 56 AND name = 'BosunHandoffs'
  `;
});
