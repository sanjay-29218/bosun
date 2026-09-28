import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

export const BotRole = Schema.Literals([
  "captain",
  "manager",
  "planner",
  "designer",
  "execution",
  "reviewer",
]);

export const BotDefinitionSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  role: BotRole,
  name: Schema.String,
  enabled: Schema.Boolean,
});

export const BotRunSummary = Schema.Struct({
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

export const BotHandoff = Schema.Struct({
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
export type BotHandoff = typeof BotHandoff.Type;

export const BotProjectSnapshotInput = Schema.Struct({ projectId: ProjectId });
export const BotProjectSnapshot = Schema.Struct({
  definitions: Schema.Array(BotDefinitionSummary),
  runs: Schema.Array(BotRunSummary),
  handoffs: Schema.Array(BotHandoff),
});
export type BotProjectSnapshot = typeof BotProjectSnapshot.Type;

export const BotStartInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  taskText: Schema.String,
});
export const BotStartResult = Schema.Struct({
  runId: Schema.String,
  threadId: ThreadId,
});
export const BotHandoffActionInput = Schema.Struct({
  projectId: ProjectId,
  requestId: Schema.String,
  text: Schema.optional(Schema.String),
});

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
