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
