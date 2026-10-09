import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

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

export class FeatureOperationError extends Schema.TaggedError<FeatureOperationError>()(
  "FeatureOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
