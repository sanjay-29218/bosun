import { OrchestratorMcpFailure, ThreadId, WorkflowFeatureSnapshot } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { FeatureService } from "../../../features/FeatureService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  FeatureService,
];

const AttachThread = Tool.make("t3_feature_attach_thread", {
  description:
    "Make a thread a Crew feature: attach it to a workflow as the stage you choose. Omit threadId for this thread. The thread keeps its history, branch and worktree; earlier stages are skipped. If the thread's last turn finished, the stage completes and hands on to the next stage, through its gate if it has one; otherwise it completes when the turn ends. Retrying with the same featureId returns the same feature.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    workflowId: Schema.String,
    stageId: Schema.String,
    title: Schema.optional(Schema.String),
    featureId: Schema.optional(Schema.String),
  }),
  success: WorkflowFeatureSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
}).annotate(Tool.Idempotent, true);

const DetachThread = Tool.make("t3_feature_detach_thread", {
  description:
    "Detach a feature's current stage thread from its workflow. Omit threadId for this thread. The thread carries on as a plain thread and the rest of the feature is cancelled; reopening the feature reattaches it.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    requestId: Schema.optional(Schema.String),
  }),
  success: WorkflowFeatureSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies,
}).annotate(Tool.Destructive, true);

export const FeaturesToolkit = Toolkit.make(AttachThread, DetachThread);
