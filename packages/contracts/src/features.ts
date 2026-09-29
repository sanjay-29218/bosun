import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

export const FeatureCreateInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  title: Schema.String,
  brief: Schema.String,
});
export const FeatureRecord = Schema.Struct({
  ...FeatureCreateInput.fields,
  createdAt: Schema.String,
});
export const FeatureProjectInput = Schema.Struct({ projectId: ProjectId });
export const FeatureGetInput = Schema.Struct({
  projectId: ProjectId,
  featureId: Schema.String,
});

export class FeatureOperationError extends Schema.TaggedError<FeatureOperationError>()(
  "FeatureOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
