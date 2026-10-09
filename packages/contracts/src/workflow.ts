import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

export const WorkflowBot = Schema.Struct({
  template: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("template"), id: Schema.String, revision: Schema.Int }),
    Schema.Struct({ kind: Schema.Literal("existing-project-bot"), id: Schema.String }),
  ]),
  supervisor: Schema.NullOr(Schema.String),
});
export type WorkflowBot = typeof WorkflowBot.Type;

/** Earlier outputs a stage receives: produced file paths, and step ids whose diff it gets. */
export const WorkflowStepReceives = Schema.Struct({
  files: Schema.Array(Schema.String),
  diffs: Schema.Array(Schema.String),
});
export type WorkflowStepReceives = typeof WorkflowStepReceives.Type;

export const WorkflowStep = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("task"),
    bot: Schema.String,
    task: Schema.String,
    next: Schema.Record(Schema.String, Schema.String),
    /** Files this stage writes, relative to the worktree root. */
    outputs: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Absent means every output of earlier completed stages. */
    receives: Schema.optionalKey(WorkflowStepReceives),
    scope: Schema.optionalKey(Schema.String),
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
    "paused",
    "resumed",
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

/** Exact result shape accepted from a completed workflow bot handoff. */
export const WorkflowHandoffOutcome = Schema.Struct({
  outcome: Schema.String,
  summary: Schema.String,
});
export type WorkflowHandoffOutcome = typeof WorkflowHandoffOutcome.Type;

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
  threadId: Schema.NullOr(ThreadId),
  outcome: Schema.NullOr(Schema.String),
});
export type WorkflowStepSnapshot = typeof WorkflowStepSnapshot.Type;

/**
 * A stage result a later stage can receive. `version` counts the producing step's
 * completed executions, so a reworked design is `design.md` version 2.
 */
export const WorkflowStageOutput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("file"),
    path: Schema.String,
    stepId: Schema.String,
    version: Schema.Int,
    threadId: Schema.NullOr(ThreadId),
    /** Whether the file was in the worktree when the handoff was built. */
    exists: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    kind: Schema.Literal("diff"),
    stepId: Schema.String,
    version: Schema.Int,
    threadId: ThreadId,
    /** Pass to the full-thread diff of `threadId` to show the same range. */
    turnCount: Schema.Int,
    fromRef: Schema.String,
    toRef: Schema.String,
    additions: Schema.Int,
    deletions: Schema.Int,
    fileCount: Schema.Int,
  }),
]);
export type WorkflowStageOutput = typeof WorkflowStageOutput.Type;

/**
 * Text that reaches a stage alongside its outputs. `routed` is the summary of the
 * step whose outcome led here; `decision` is a person's note on a recorded decision.
 */
export const WorkflowStageNote = Schema.Struct({
  stepId: Schema.String,
  kind: Schema.Literals(["routed", "decision"]),
  outcome: Schema.NullOr(Schema.String),
  text: Schema.String,
  actorId: Schema.String,
  occurredAt: Schema.String,
});
export type WorkflowStageNote = typeof WorkflowStageNote.Type;

/** Everything one stage attempt starts from. The stage prompt is rendered from this alone. */
export const WorkflowStageHandoff = Schema.Struct({
  id: Schema.String,
  featureId: Schema.String,
  stepId: Schema.String,
  executionId: Schema.String,
  attempt: Schema.Int,
  workflow: Schema.Struct({ id: Schema.String, name: Schema.String, revision: Schema.Int }),
  from: Schema.NullOr(Schema.Struct({ stepId: Schema.String, outcome: Schema.String })),
  brief: Schema.String,
  task: Schema.String,
  scope: Schema.NullOr(Schema.String),
  outcomes: Schema.Array(Schema.String),
  produces: Schema.Array(Schema.String),
  outputs: Schema.Array(WorkflowStageOutput),
  notes: Schema.Array(WorkflowStageNote),
  retry: Schema.NullOr(Schema.Struct({ previousError: Schema.String })),
  workspace: Schema.Struct({
    cwd: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    commit: Schema.NullOr(Schema.String),
  }),
  createdAt: Schema.String,
});
export type WorkflowStageHandoff = typeof WorkflowStageHandoff.Type;

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
  paused: Schema.optionalKey(Schema.Boolean),
  executionConfigured: Schema.optionalKey(Schema.Boolean),
  executionError: Schema.optionalKey(Schema.NullOr(Schema.String)),
  historyLength: Schema.Int,
  recentEvents: Schema.Array(WorkflowStepEvent),
  /** Latest version of every output produced so far, for the Feature tab. */
  outputs: Schema.optionalKey(Schema.Array(WorkflowStageOutput)),
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
export const WorkflowStageHandoffInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export const WorkflowActionInput = Schema.Struct({
  ...WorkflowFeatureGetInput.fields,
  requestId: Schema.String,
});
export const WorkflowAnswerInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  text: Schema.String,
});
export const WorkflowCreateInput = Schema.Struct({
  projectId: ProjectId,
  definition: WorkflowDefinition,
});
export const WorkflowReviseInput = Schema.Struct({
  ...WorkflowCreateInput.fields,
  expectedRevision: Schema.Int,
});
