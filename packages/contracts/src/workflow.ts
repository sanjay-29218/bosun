import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * One of a workflow's roles: the global role it runs as, pinned to a revision, and the
 * workflow role that supervises it. Each feature gets its own member of every role, except
 * the project manager role, which binds to the project's single manager.
 */
export const WorkflowRole = Schema.Struct({
  roleId: Schema.String,
  roleRevision: Schema.Int,
  supervisor: Schema.NullOr(Schema.String),
});
export type WorkflowRole = typeof WorkflowRole.Type;

/** Earlier outputs a stage receives: produced file paths, and step ids whose diff it gets. */
export const WorkflowStepReceives = Schema.Struct({
  files: Schema.Array(Schema.String),
  diffs: Schema.Array(Schema.String),
});
export type WorkflowStepReceives = typeof WorkflowStepReceives.Type;

export const WorkflowStep = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("task"),
    /** The key in `WorkflowDefinition.roles` that performs this stage. */
    role: Schema.String,
    task: Schema.String,
    next: Schema.Record(Schema.String, Schema.String),
    /** The stage waits for Approve or Request changes before it routes on. */
    gate: Schema.optionalKey(Schema.Boolean),
    /** How many times each outcome's route may be taken before the feature asks for Your call. */
    limits: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)),
    /** Files this stage writes, relative to the worktree root. */
    outputs: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Absent means every output of earlier completed stages. */
    receives: Schema.optionalKey(WorkflowStepReceives),
    scope: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("end") }),
]);
export type WorkflowStep = typeof WorkflowStep.Type;

/** Where the canvas editor draws each step, by step id. Steps without one are placed automatically. */
export const WorkflowLayout = Schema.Record(
  Schema.String,
  Schema.Struct({ x: Schema.Number, y: Schema.Number }),
);
export type WorkflowLayout = typeof WorkflowLayout.Type;

/** Workflows are a global library; features copy the version they run on. */
export const WorkflowDefinition = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Int,
  start: Schema.String,
  roles: Schema.Record(Schema.String, WorkflowRole),
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
  layout: Schema.optionalKey(WorkflowLayout),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

/** The first route without a limit, which is how Skip and "Accept as is" move forward. */
export const workflowForwardOutcome = (
  definition: WorkflowDefinition,
  stepId: string,
): string | null => {
  const step = definition.steps[stepId];
  if (step?.type !== "task") return null;
  const outcomes = Object.keys(step.next);
  return outcomes.find((outcome) => step.limits?.[outcome] === undefined) ?? outcomes[0] ?? null;
};

/**
 * Task steps met by following each stage's forward route from the start. These are the
 * stages a thread can be attached at; the ones before it are skipped.
 */
export const workflowForwardStages = (definition: WorkflowDefinition): ReadonlyArray<string> => {
  const stages: Array<string> = [];
  let stepId: string | undefined = definition.start;
  while (stepId !== undefined && definition.steps[stepId]?.type === "task") {
    if (stages.includes(stepId)) break;
    stages.push(stepId);
    const outcome = workflowForwardOutcome(definition, stepId);
    const step: WorkflowStep | undefined = definition.steps[stepId];
    stepId = outcome !== null && step?.type === "task" ? step.next[outcome] : undefined;
  }
  return stages;
};

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
    "attached",
  ]),
  runId: Schema.NullOr(Schema.String),
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
  /** The existing thread an `attached` event makes the stage's thread. */
  threadId: Schema.optionalKey(ThreadId),
});
export type WorkflowStepEvent = typeof WorkflowStepEvent.Type;

/** Exact result shape accepted from a completed workflow stage handoff. */
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
  runId: Schema.NullOr(Schema.String),
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
  /**
   * The feature's event version, on the current stage thread only. It changes with every
   * decision, so an open stage thread knows to reload the feature.
   */
  revision: Schema.optionalKey(Schema.Int),
});
export type CrewStageSummary = typeof CrewStageSummary.Type;

/** The issue a feature works on, as it read when linked. */
export const FeatureIssue = Schema.Struct({
  url: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  state: Schema.Literals(["open", "closed"]),
  milestone: Schema.NullOr(Schema.String),
  /** Its sub-issues, closed and in all; null when it has none. */
  subIssues: Schema.NullOr(Schema.Struct({ completed: Schema.Int, total: Schema.Int })),
});
export type FeatureIssue = typeof FeatureIssue.Type;

/** The feature a crew thread works on: its stage threads and its lead's thread. */
export const ThreadFeatureTag = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  issue: Schema.optionalKey(FeatureIssue),
});
export type ThreadFeatureTag = typeof ThreadFeatureTag.Type;
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
  state: Schema.optionalKey(FeatureCardState),
  queuedAt: Schema.optionalKey(Schema.NullOr(Schema.String)),
  stage: Schema.optionalKey(Schema.NullOr(WorkflowStagePosition)),
  yourCall: Schema.optionalKey(Schema.NullOr(WorkflowYourCall)),
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

export const WorkflowLibraryInput = Schema.Struct({});
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
export const WorkflowCreateInput = Schema.Struct({ definition: WorkflowDefinition });
export const WorkflowReviseInput = Schema.Struct({
  ...WorkflowCreateInput.fields,
  expectedRevision: Schema.Int,
});
