import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Workflows from "./060_Workflows.ts";
import WorkflowStepEvents from "./061_WorkflowStepEvents.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Feature-only databases already recorded migration 62, so the migrator
  // skips Workflow's earlier slots when the branches are combined.
  const workflowTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN ('workflow_definition_revisions', 'workflow_step_events')
  `;
  if (!workflowTables.some((table) => table.name === "workflow_definition_revisions"))
    yield* Workflows;
  if (!workflowTables.some((table) => table.name === "workflow_step_events"))
    yield* WorkflowStepEvents;
  yield* sql`
    CREATE TABLE bot_handoff_receipts (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      handoff_id TEXT NOT NULL REFERENCES bot_handoffs(id),
      handoff_json TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX bot_handoff_receipts_handoff ON bot_handoff_receipts(handoff_id, sequence)`;
});
