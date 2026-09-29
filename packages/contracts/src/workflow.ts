import * as Schema from "effect/Schema";

const WorkflowStepBase = {
  id: Schema.String,
  dependsOn: Schema.Array(Schema.String),
};

export const WorkflowStep = Schema.Union([
  Schema.Struct({
    ...WorkflowStepBase,
    kind: Schema.Literal("bot"),
    templateId: Schema.String,
    completion: Schema.Literal("handoff"),
  }),
  Schema.Struct({
    ...WorkflowStepBase,
    kind: Schema.Literal("decision"),
    approver: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("person") }),
      Schema.Struct({ kind: Schema.Literal("bot"), templateId: Schema.String }),
    ]),
  }),
  Schema.Struct({ ...WorkflowStepBase, kind: Schema.Literal("end") }),
]);
export type WorkflowStep = typeof WorkflowStep.Type;

export const WorkflowDefinition = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  revision: Schema.Int,
  steps: Schema.Array(WorkflowStep),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

export const WorkflowStepEvent = Schema.Struct({
  id: Schema.String,
  stepId: Schema.String,
  kind: Schema.Literals([
    "started",
    "completed",
    "question",
    "answered",
    "change-requested",
    "change-resolved",
    "failed",
    "retry",
    "cancelled",
  ]),
  botRunId: Schema.NullOr(Schema.String),
  sourceKind: Schema.NullOr(Schema.Literals(["handoff", "decision", "workflow"])),
  sourceId: Schema.NullOr(Schema.String),
  actorId: Schema.String,
  detail: Schema.NullOr(Schema.String),
  occurredAt: Schema.String,
});
export type WorkflowStepEvent = typeof WorkflowStepEvent.Type;
