import * as Schema from "effect/Schema";
import { ProjectId } from "./baseSchemas.ts";

export const WorkflowBot = Schema.Struct({
  template: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("template"), id: Schema.String, revision: Schema.Int }),
    Schema.Struct({ kind: Schema.Literal("existing-project-bot"), id: Schema.String }),
  ]),
  supervisor: Schema.NullOr(Schema.String),
});
export type WorkflowBot = typeof WorkflowBot.Type;

export const WorkflowStep = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("task"),
    bot: Schema.String,
    task: Schema.String,
    next: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("end") }),
]);
export type WorkflowStep = typeof WorkflowStep.Type;

export const WorkflowDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Int,
  start: Schema.String,
  bots: Schema.Record(Schema.String, WorkflowBot),
  steps: Schema.Record(Schema.String, WorkflowStep),
  defaults: Schema.Struct({
    questions: Schema.Literal("supervisor"),
    failure: Schema.Literal("pause"),
    maxAttemptsPerExecution: Schema.Int,
    maxStepExecutions: Schema.Int,
  }),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export const WorkflowStepEvent = Schema.Struct({
  id: Schema.String,
  stepId: Schema.String,
  executionId: Schema.NullOr(Schema.String),
  kind: Schema.Literals([
    "started",
    "completed",
    "question",
    "answered",
    "failed",
    "retry",
    "cancelled",
  ]),
  botRunId: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.String),
  sourceKind: Schema.NullOr(Schema.Literals(["handoff", "decision", "workflow"])),
  sourceId: Schema.NullOr(Schema.String),
  actorId: Schema.String,
  detail: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
});
export type WorkflowStepEvent = typeof WorkflowStepEvent.Type;

export const WorkflowStepSnapshot = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals([
    "pending",
    "running",
    "needs-input",
    "completed",
    "failed",
    "cancelled",
  ]),
  executionId: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  botRunId: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.String),
});
export type WorkflowStepSnapshot = typeof WorkflowStepSnapshot.Type;

export const WorkflowFeatureSnapshot = Schema.Struct({
  featureId: Schema.String,
  projectId: ProjectId,
  definition: WorkflowDefinition,
  eventVersion: Schema.Int,
  createdAt: Schema.String,
  steps: Schema.Array(WorkflowStepSnapshot),
  activeStepId: Schema.NullOr(Schema.String),
  readyStepIds: Schema.Array(Schema.String),
  executionCount: Schema.Int,
  completed: Schema.Boolean,
  cancelled: Schema.Boolean,
  historyLength: Schema.Int,
  recentEvents: Schema.Array(WorkflowStepEvent),
});
export type WorkflowFeatureSnapshot = typeof WorkflowFeatureSnapshot.Type;

export class WorkflowOperationError extends Schema.TaggedError<WorkflowOperationError>()(
  "WorkflowOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const WorkflowProjectInput = Schema.Struct({ projectId: ProjectId });
export const WorkflowFeatureGetInput = Schema.Struct({
  projectId: ProjectId,
  featureId: Schema.String,
});
export const WorkflowCreateInput = Schema.Struct({
  projectId: ProjectId,
  definition: WorkflowDefinition,
});
export const WorkflowReviseInput = Schema.Struct({
  ...WorkflowCreateInput.fields,
  expectedRevision: Schema.Int,
});
