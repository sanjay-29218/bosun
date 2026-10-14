import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  CrewStageSummary,
  FeatureCardState,
  FeatureIssue,
  WorkflowStagePosition,
  WorkflowYourCall,
} from "./workflow.ts";

const FeatureFields = {
  id: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  brief: Schema.String,
  workflowId: Schema.optionalKey(Schema.String),
};
export const FeatureCreateInput = Schema.Struct({
  ...FeatureFields,
  /**
   * `title` is a stand-in taken from the brief: the server replaces it with a short generated
   * title, as it does for thread titles. A retry may then send the stand-in again.
   */
  autoTitle: Schema.optionalKey(Schema.Boolean),
});
export const FeatureRecord = Schema.Struct({
  ...FeatureFields,
  workflowId: Schema.NullOr(Schema.String),
  /** The workflow version this feature runs on. Publishing later versions never changes it. */
  workflowRevision: Schema.NullOr(Schema.Int),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals(["open", "closed"]),
  /** The crew member bound to each of the workflow's roles. */
  crewAssignments: Schema.Record(Schema.String, Schema.String),
  issue: Schema.NullOr(FeatureIssue),
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
/** Links the issue at `url` to the feature, replacing any other; null unlinks it. */
export const FeatureSetIssueInput = Schema.Struct({
  ...FeatureGetInput.fields,
  url: Schema.NullOr(Schema.String),
});

export const FeatureStartInput = FeatureGetInput;
/** From Done, `stepId` picks the stage the follow-up starts at. */
export const FeatureReopenInput = Schema.Struct({
  ...FeatureGetInput.fields,
  requestId: Schema.String,
  stepId: Schema.optionalKey(Schema.String),
});

/**
 * Makes an existing thread the `stageId` stage of a new feature. `featureId` is chosen by
 * the caller, so a retry with the same ID returns the same feature.
 */
export const FeatureAttachThreadInput = Schema.Struct({
  featureId: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  workflowId: Schema.String,
  stageId: Schema.String,
  title: Schema.String,
});
/** Turns a feature's current stage thread back into a plain thread and cancels the feature. */
export const FeatureDetachThreadInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  requestId: Schema.String,
});
export const FeatureThreadInput = Schema.Struct({ projectId: ProjectId, threadId: ThreadId });
/** What a thread is to Crew: a feature's stage thread, or a plain thread that may become one. */
export const FeatureThreadLink = Schema.Struct({
  stage: Schema.NullOr(CrewStageSummary),
  /** False for crew threads, which belong to the crew rather than to a person. */
  attachable: Schema.Boolean,
});
export type FeatureThreadLink = typeof FeatureThreadLink.Type;
/**
 * One card on the Features board, for a feature that runs a workflow. Everything else
 * about the feature loads when its stage thread is opened.
 */
export const FeatureBoardCard = Schema.Struct({
  featureId: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  issue: Schema.NullOr(FeatureIssue),
  workflow: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    /** The version this feature runs on. */
    revision: Schema.Int,
    /** The library's latest version; null once the workflow is deleted. */
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
      /** The workflow role that owns the stage, such as "designer". */
      role: Schema.String,
      attempt: Schema.Int,
      gate: Schema.Boolean,
      /** A person took the stage over; it waits for Mark done or Retry. */
      takenOver: Schema.Boolean,
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
