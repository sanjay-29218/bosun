import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

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
    /** The stage waits for Approve or Request changes before it routes on. */
    gate: Schema.optionalKey(Schema.Boolean),
    /** How many times each outcome's route may be taken before the feature asks for Your call. */
    limits: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
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
    /** No longer enforced: a person's Retry is always allowed. */
    maxAttemptsPerExecution: Schema.optionalKey(Schema.Int),
    maxStepExecutions: Schema.Int,
    /** Automatic retries before a stage fails. Absent uses the environment's Crew setting. */
    retries: Schema.optionalKey(Schema.Int),
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
    "approved",
    "changes-requested",
    "taken-over",
    "marked-done",
    "skipped",
    "sent-back",
    "reopened",
    "accepted",
    "extended",
  ]),
  botRunId: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(Schema.String),
  sourceKind: Schema.NullOr(Schema.Literals(["handoff", "decision", "workflow"])),
  sourceId: Schema.NullOr(Schema.String),
  actorId: Schema.String,
  detail: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
  /** The earlier stage a `sent-back` event restarts. */
  targetStepId: Schema.optionalKey(Schema.String),
  /** A `retry` override that applies to the rest of the stage's execution. */
  modelSelection: Schema.optionalKey(ModelSelection),
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
    "awaiting-approval",
    "limit-reached",
    "taken-over",
    "skipped",
  ]),
  executionId: Schema.NullOr(Schema.String),
  attempt: Schema.Int,
  botRunId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  outcome: Schema.NullOr(Schema.String),
  /** The outcome held by a gate or a route limit until a person decides. */
  pendingOutcome: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type WorkflowStepSnapshot = typeof WorkflowStepSnapshot.Type;

/** The board column a feature sits in. Each state has a way out (see WorkflowState.ts). */
export const FeatureCardState = Schema.Literals([
  "working",
  "queued",
  "approval",
  "input",
  "your-call",
  "failed",
  "paused",
  "cancelled",
  "done",
]);
export type FeatureCardState = typeof FeatureCardState.Type;

/** Why a feature stopped at Your call. */
export const WorkflowYourCall = Schema.Struct({
  reason: Schema.Literals(["loop-limit", "execution-limit"]),
  stepId: Schema.String,
  outcome: Schema.String,
  target: Schema.String,
});
export type WorkflowYourCall = typeof WorkflowYourCall.Type;

/** A stage's position among the workflow's task steps, counted from 1. */
export const WorkflowStagePosition = Schema.Struct({
  stepId: Schema.String,
  index: Schema.Int,
  total: Schema.Int,
});
export type WorkflowStagePosition = typeof WorkflowStagePosition.Type;

/** The board summary carried on a stage thread's shell. */
export const CrewStageSummary = Schema.Struct({
  featureId: Schema.String,
  ...WorkflowStagePosition.fields,
  state: FeatureCardState,
  /** False for an earlier attempt or stage of the same feature. */
  current: Schema.Boolean,
});
export type CrewStageSummary = typeof CrewStageSummary.Type;

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
  state: Schema.optionalKey(FeatureCardState),
  queuedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stage: Schema.optionalKey(Schema.NullOr(WorkflowStagePosition)),
  yourCall: Schema.optionalKey(Schema.NullOr(WorkflowYourCall)),
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
export const WorkflowActionInput = Schema.Struct({
  ...WorkflowFeatureGetInput.fields,
  requestId: Schema.String,
});
export const WorkflowAnswerInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  text: Schema.String,
});
const Note = Schema.optionalKey(Schema.String);
export const WorkflowRetryInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  modelSelection: Schema.optionalKey(ModelSelection),
});
export const WorkflowApproveInput = Schema.Struct({ ...WorkflowActionInput.fields, note: Note });
export const WorkflowRequestChangesInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  note: Schema.String,
});
export const WorkflowSendBackInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  stepId: Schema.String,
  note: Note,
});
export const WorkflowMarkDoneInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  outcome: Schema.String,
  summary: Schema.String,
});
/** Without an outcome, the stage's first route that has no limit is taken. */
export const WorkflowRouteInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  outcome: Schema.optionalKey(Schema.String),
});
/** From Done, `stepId` picks the stage the follow-up starts at. */
export const WorkflowReopenInput = Schema.Struct({
  ...WorkflowActionInput.fields,
  stepId: Schema.optionalKey(Schema.String),
});
export const WorkflowCreateInput = Schema.Struct({
  projectId: ProjectId,
  definition: WorkflowDefinition,
});
export const WorkflowReviseInput = Schema.Struct({
  ...WorkflowCreateInput.fields,
  expectedRevision: Schema.Int,
});
