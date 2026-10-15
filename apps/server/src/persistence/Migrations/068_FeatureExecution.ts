import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE features ADD COLUMN owner_id TEXT`;
  yield* sql`CREATE TABLE feature_checkouts (
    feature_id TEXT PRIMARY KEY REFERENCES features(id), project_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('worktree', 'workspace')),
    phase TEXT NOT NULL CHECK (phase IN ('pending', 'ready', 'failed')),
    project_cwd TEXT NOT NULL, path TEXT, branch TEXT, base_branch TEXT,
    actor_id TEXT NOT NULL, last_error TEXT, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX feature_checkouts_path ON feature_checkouts(path) WHERE path IS NOT NULL`;
  yield* sql`CREATE TABLE feature_writer_leases (
    path TEXT PRIMARY KEY, thread_id TEXT NOT NULL, command_id TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX feature_writer_leases_thread ON feature_writer_leases(thread_id)`;
  yield* sql`CREATE TABLE feature_run_links (
    run_id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES features(id),
    kind TEXT NOT NULL CHECK (kind IN ('coordination', 'task'))
  )`;
  yield* sql`CREATE INDEX feature_run_links_feature ON feature_run_links(feature_id, run_id)`;
  yield* sql`CREATE TABLE feature_artifacts (
    id TEXT PRIMARY KEY, feature_id TEXT NOT NULL REFERENCES features(id),
    kind TEXT NOT NULL CHECK (kind IN ('pull-request', 'linear', 'figma', 'other')),
    title TEXT NOT NULL, url TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('linked', 'pending', 'succeeded', 'failed', 'declined')),
    detail TEXT, actor_id TEXT NOT NULL, thread_id TEXT, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX feature_artifacts_feature ON feature_artifacts(feature_id, created_at, id)`;
});
