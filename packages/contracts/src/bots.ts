import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const BosunBotRole = Schema.Literals([
  "captain",
  "manager",
  "planner",
  "designer",
  "execution",
  "reviewer",
]);

export const BosunBotDefinitionSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  role: BosunBotRole,
  name: Schema.String,
  enabled: Schema.Boolean,
});

export const BosunBotRunSummary = Schema.Struct({
  id: Schema.String,
  botId: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  dispatchState: Schema.Literals(["queued", "started"]),
  turnState: Schema.Literals([
    "missing",
    "pending",
    "running",
    "completed",
    "interrupted",
    "error",
  ]),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export const BosunHandoff = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  sourceRunId: Schema.String,
  targetBotId: Schema.String,
  targetRunId: Schema.String,
  projectId: ProjectId,
  taskText: Schema.String,
  contextText: Schema.String,
  depth: Schema.Int,
  status: Schema.Literals(["queued", "running", "completed", "needs-input", "failed", "cancelled"]),
  responseText: Schema.NullOr(Schema.String),
  questionText: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type BosunHandoff = typeof BosunHandoff.Type;

export const BosunProjectSnapshotInput = Schema.Struct({ projectId: ProjectId });
export const BosunProjectSnapshot = Schema.Struct({
  definitions: Schema.Array(BosunBotDefinitionSummary),
  runs: Schema.Array(BosunBotRunSummary),
  handoffs: Schema.Array(BosunHandoff),
});
export type BosunProjectSnapshot = typeof BosunProjectSnapshot.Type;

export const BosunStartInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  taskText: Schema.String,
});
export const BosunStartResult = Schema.Struct({
  runId: Schema.String,
  threadId: ThreadId,
});
export const BosunHandoffActionInput = Schema.Struct({
  projectId: ProjectId,
  requestId: Schema.String,
  text: Schema.optional(Schema.String),
});

export class BosunOperationError extends Schema.TaggedError<BosunOperationError>()(
  "BosunOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
