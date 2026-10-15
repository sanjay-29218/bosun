import * as Schema from "effect/Schema";

import { BotDefinitionSummary, BotRunSummary, BotHandoff } from "./bots.ts";
import { ProjectId, ThreadId } from "./baseSchemas.ts";

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
  createdAt: Schema.String,
  updatedAt: Schema.String,
  status: Schema.Literals(["open", "closed"]),
  ownerId: Schema.NullOr(Schema.String),
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
export const FeatureLaunchInput = Schema.Struct({
  ...FeatureGetInput.fields,
  sourceRunId: Schema.String,
});
export const FeatureLaunchRecord = Schema.Struct({
  featureId: Schema.String,
  projectId: ProjectId,
  sourceRunId: Schema.String,
  actorId: Schema.String,
  phase: Schema.Literals(["pending", "attached", "cancelled"]),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export class FeatureOperationError extends Schema.TaggedError<FeatureOperationError>()(
  "FeatureOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export const FeatureCheckout = Schema.Struct({
  featureId: Schema.String,
  projectId: ProjectId,
  mode: Schema.Literals(["worktree", "workspace"]),
  phase: Schema.Literals(["pending", "ready", "failed"]),
  setupThreadId: Schema.NullOr(ThreadId),
  projectCwd: Schema.String,
  path: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  baseBranch: Schema.NullOr(Schema.String),
  actorId: Schema.String,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
});
export type FeatureCheckout = typeof FeatureCheckout.Type;
export const FeaturePrepareCheckoutInput = Schema.Struct({
  ...FeatureGetInput.fields,
  mode: Schema.Literals(["worktree", "workspace"]),
  baseBranch: Schema.optionalKey(Schema.String),
});
export const FeatureArtifact = Schema.Struct({
  id: Schema.String,
  featureId: Schema.String,
  kind: Schema.Literals(["pull-request", "linear", "figma", "other"]),
  title: Schema.String,
  url: Schema.String,
  status: Schema.Literals(["linked", "pending", "succeeded", "failed", "declined"]),
  detail: Schema.NullOr(Schema.String),
  actorId: Schema.String,
  threadId: Schema.NullOr(ThreadId),
  createdAt: Schema.String,
});
export type FeatureArtifact = typeof FeatureArtifact.Type;
export const FeatureRecordArtifactInput = Schema.Struct({
  ...FeatureGetInput.fields,
  id: Schema.String,
  kind: FeatureArtifact.fields.kind,
  title: Schema.String,
  url: Schema.String,
  status: FeatureArtifact.fields.status,
  detail: Schema.optionalKey(Schema.String),
  threadId: Schema.optionalKey(ThreadId),
});
export const FeatureInspection = Schema.Struct({
  feature: FeatureRecord,
  checkout: Schema.NullOr(FeatureCheckout),
  writerThreadId: Schema.NullOr(ThreadId),
  bots: Schema.Array(BotDefinitionSummary),
  runs: Schema.Array(BotRunSummary),
  handoffs: Schema.Array(BotHandoff),
  artifacts: Schema.Array(FeatureArtifact),
});
export type FeatureInspection = typeof FeatureInspection.Type;
