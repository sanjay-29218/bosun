import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE workflow_definition_heads (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      PRIMARY KEY (project_id, id)
    )
  `;
  yield* sql`
    CREATE TABLE workflow_definition_revisions (
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, id, revision),
      FOREIGN KEY (project_id, id) REFERENCES workflow_definition_heads(project_id, id)
    )
  `;
  yield* sql`
    CREATE TABLE feature_workflows (
      feature_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_revision INTEGER NOT NULL,
      definition_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id, workflow_id, workflow_revision)
        REFERENCES workflow_definition_revisions(project_id, id, revision)
    )
  `;
  yield* sql`
    CREATE INDEX feature_workflows_project ON feature_workflows (project_id, created_at, feature_id)
  `;
});
