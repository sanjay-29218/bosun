import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { FeatureCardState, WorkflowStagePosition, WorkflowYourCall } from "./workflow.ts";

export const FeatureCreateInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  brief: Schema.String,
  workflowId: Schema.optionalKey(Schema.String),
});
export const FeatureRecord = Schema.Struct({
  ...FeatureCreateInput.fields,
  workflowId: Schema.NullOr(Schema.String),
  /** The workflow version this feature runs on. Publishing later versions never changes it. */
  workflowRevision: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals(["open", "closed"]),
  botAssignments: Schema.Record(Schema.String, Schema.String),
});
export const FeatureProjectInput = Schema.Struct({ projectId: ProjectId });
export const FeatureGetInput = Schema.Struct({
  projectId: ProjectId,
  featureId: Schema.String,
});
export const FeatureSetStatusInput = Schema.Struct({
  ...FeatureGetInput.fields,
  status: Schema.Literals(["open", "closed"]),
});

export const FeatureStartInput = FeatureGetInput;
/** From Done, `stepId` picks the stage the follow-up starts at. */
export const FeatureReopenInput = Schema.Struct({
  ...FeatureGetInput.fields,
  requestId: Schema.String,
  stepId: Schema.optionalKey(Schema.String),
});

/**
 * One card on the Features board, for a feature that runs a workflow. Everything else
 * about the feature loads when its stage thread is opened.
 */
export const FeatureBoardCard = Schema.Struct({
  featureId: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  workflow: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    /** The version this feature runs on. */
    revision: Schema.Int,
    /** The project's latest version; null once the workflow is deleted. */
    latestRevision: Schema.NullOr(Schema.Int),
  }),
  state: FeatureCardState,
  /** False until `features.start` attaches the crew. */
  started: Schema.Boolean,
  /** When the feature entered `state`, used to order what waits on you. */
  stateSince: Schema.String,
  stage: Schema.NullOr(
    Schema.Struct({
      ...WorkflowStagePosition.fields,
      /** The workflow bot name that owns the stage, such as "designer". */
      role: Schema.String,
      attempt: Schema.Int,
      gate: Schema.Boolean,
    }),
  ),
  /** The current (or last) stage thread, which a card opens. */
  threadId: Schema.NullOr(ThreadId),
  /** The question, failure reason or decision note behind the state, trimmed. */
  detail: Schema.NullOr(Schema.String),
  yourCall: Schema.NullOr(WorkflowYourCall),
  queuedAt: Schema.NullOr(Schema.String),
});
export type FeatureBoardCard = typeof FeatureBoardCard.Type;

export class FeatureOperationError extends Schema.TaggedError<FeatureOperationError>()(
  "FeatureOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
