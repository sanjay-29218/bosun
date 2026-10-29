import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/*
 * A feature works in one workspace: a worktree and branch made when its first stage starts,
 * or the project's checkout. Every crew run it starts records that workspace, so a replayed
 * or restored thread opens in the same place. Features from before this keep working locally.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).map((row) => row.name),
  );
  // Databases upgraded from before the crew have neither table yet; they create them later.
  if (tables.has("features")) {
    yield* sql`
      ALTER TABLE features ADD COLUMN workspace TEXT NOT NULL DEFAULT 'local'
        CHECK (workspace IN ('worktree', 'local'))
    `;
    yield* sql`ALTER TABLE features ADD COLUMN base_branch TEXT`;
    yield* sql`ALTER TABLE features ADD COLUMN branch TEXT`;
    yield* sql`ALTER TABLE features ADD COLUMN worktree_path TEXT`;
  }
  if (tables.has("crew_runs")) {
    yield* sql`ALTER TABLE crew_runs ADD COLUMN branch TEXT`;
    yield* sql`ALTER TABLE crew_runs ADD COLUMN worktree_path TEXT`;
  }
});
