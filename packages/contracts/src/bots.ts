import * as Schema from "effect/Schema";

import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const BOT_TURN_STATE = {
  MISSING: "missing",
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  INTERRUPTED: "interrupted",
  ERROR: "error",
} as const;
export type BotTurnState = (typeof BOT_TURN_STATE)[keyof typeof BOT_TURN_STATE];
export const BotTurnStateSchema = Schema.Literals([
  BOT_TURN_STATE.MISSING,
  BOT_TURN_STATE.PENDING,
  BOT_TURN_STATE.RUNNING,
  BOT_TURN_STATE.COMPLETED,
  BOT_TURN_STATE.INTERRUPTED,
  BOT_TURN_STATE.ERROR,
]);

export const BOT_DISPATCH_STATE = {
  QUEUED: "queued",
  STARTED: "started",
} as const;
export type BotDispatchState = (typeof BOT_DISPATCH_STATE)[keyof typeof BOT_DISPATCH_STATE];
export const BotDispatchStateSchema = Schema.Literals([
  BOT_DISPATCH_STATE.QUEUED,
  BOT_DISPATCH_STATE.STARTED,
]);

export const BotDefinitionSummary = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  featureId: Schema.NullOr(Schema.String),
  templateId: Schema.NullOr(Schema.String),
  name: Schema.String,
  enabled: Schema.Boolean,
});

export const BotRunSummary = Schema.Struct({
  id: Schema.String,
  botId: Schema.String,
  projectId: ProjectId,
  threadId: ThreadId,
  dispatchState: BotDispatchStateSchema,
  turnState: BotTurnStateSchema,
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
});

export const BotHandoff = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  sourceRunId: Schema.String,
  targetBotId: Schema.String,
  targetRunId: Schema.String,
  projectId: ProjectId,
  taskText: Schema.String,
  contextText: Schema.String,
  depth: Schema.Int,
  status: Schema.Literals(["queued", "running", "completed", "needs-input", "failed", "cancelled"]),
  responseText: Schema.NullOr(Schema.String),
  questionText: Schema.NullOr(Schema.String),
  lastError: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type BotHandoff = typeof BotHandoff.Type;

export const BotProjectSnapshotInput = Schema.Struct({ projectId: ProjectId });
export const BotProjectSnapshot = Schema.Struct({
  definitions: Schema.Array(BotDefinitionSummary),
  runs: Schema.Array(BotRunSummary),
  handoffs: Schema.Array(BotHandoff),
});
export type BotProjectSnapshot = typeof BotProjectSnapshot.Type;

export const BotTemplateConfig = Schema.Struct({
  id: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  name: Schema.String,
  instructions: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  enabled: Schema.Boolean,
  autoCreateForFeature: Schema.Boolean,
  revision: Schema.Int,
});
export type BotTemplateConfig = typeof BotTemplateConfig.Type;
export const BotHierarchyNode = Schema.Struct({
  botId: Schema.String,
  parentBotId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});
export const BotDelegationGrant = Schema.Struct({
  sourceBotId: Schema.String,
  targetBotId: Schema.String,
});
export const BotConfigurationSnapshot = Schema.Struct({
  templates: Schema.Array(BotTemplateConfig),
  hierarchy: Schema.Array(BotHierarchyNode),
  delegationGrants: Schema.Array(BotDelegationGrant),
});
export const BotCreateTemplateInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  name: Schema.String,
  instructions: Schema.String,
  allowedTools: Schema.Array(Schema.String),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  autoCreateForFeature: Schema.Boolean,
});
export const BotUpdateTemplateInput = Schema.Struct({
  ...BotCreateTemplateInput.fields,
  expectedRevision: Schema.Int,
  enabled: Schema.Boolean,
});
export const BotInstantiateInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  templateId: Schema.String,
});
export const BotSetHierarchyInput = Schema.Struct({
  projectId: ProjectId,
  botId: Schema.String,
  parentBotId: Schema.NullOr(Schema.String),
  position: Schema.Int,
});
export const BotSetDelegationInput = Schema.Struct({
  projectId: ProjectId,
  sourceBotId: Schema.String,
  targetBotId: Schema.String,
  allowed: Schema.Boolean,
});
export const BotInitializeInput = Schema.Struct({
  projectId: ProjectId,
  modelSelection: ModelSelection,
});

export const BotStartInput = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  taskText: Schema.String,
});
export const BotStartResult = Schema.Struct({
  runId: Schema.String,
  threadId: ThreadId,
});
export const BotHandoffActionInput = Schema.Struct({
  projectId: ProjectId,
  requestId: Schema.String,
  text: Schema.optional(Schema.String),
});

export class BotOperationError extends Schema.TaggedError<BotOperationError>()(
  "BotOperationError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}
