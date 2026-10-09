import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  WorkflowStageHandoff,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { BotHandoffService } from "../../../bots/BotHandoffService.ts";
import { BotHandoffStore } from "../../../bots/BotHandoffStore.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class BotToolFailedError extends Schema.TaggedError<BotToolFailedError>()(
  "BotToolFailedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const dependencies = [
  McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BotHandoffService,
  BotHandoffStore,
  BotStore,
];
/** What a bot tool fails with, including the access gate's refusal. */
const failure = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  BotToolFailedError,
]);
const Handoff = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  sourceRunId: Schema.String,
  targetBotId: Schema.String,
  targetRunId: Schema.String,
  projectId: Schema.String,
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

const Delegate = Tool.make("bots_delegate", {
  description:
    "Hand a bounded project task to a permitted bot. Reuse the same request ID when retrying after a lost response.",
  parameters: Schema.Struct({
    requestId: Schema.String,
    targetBotId: Schema.String,
    taskText: Schema.String,
    contextText: Schema.optional(Schema.String),
  }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, true);

const Respond = Tool.make("bots_respond", {
  description:
    "Report a structured completed or failed outcome for the handoff that started this bot run.",
  parameters: Schema.Struct({
    outcome: Schema.Literals(["completed", "failed"]),
    summary: Schema.String,
  }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, true);

const Ask = Tool.make("bots_ask", {
  description:
    "Pause this handoff with a question for the requester. The question remains durable until answered or cancelled.",
  parameters: Schema.Struct({ question: Schema.String }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, true);

const List = Tool.make("bots_list_handoffs", {
  description: "List the requests delegated by this bot run and their current structured outcomes.",
  success: Schema.Struct({ handoffs: Schema.Array(Handoff) }),
  failure,
  dependencies,
}).annotate(Tool.Readonly, true);

const Wait = Tool.make("bots_wait_handoff", {
  description:
    "Wait up to 30 seconds for one handoff you delegated to finish or ask a question. Call again with the same request ID while it is still running.",
  parameters: Schema.Struct({ requestId: Schema.String }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Readonly, true);

const Answer = Tool.make("bots_answer", {
  description:
    "Answer a question from a handoff this bot delegated. The recipient resumes in its linked T3 thread.",
  parameters: Schema.Struct({ requestId: Schema.String, answer: Schema.String }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, false);

const StageHandoff = Tool.make("bots_stage_handoff", {
  description:
    "Read the full handoff this workflow stage started from: the brief, the outputs it receives, notes from earlier stages and people, and the branch and commit. Nothing else is passed between stages.",
  success: WorkflowStageHandoff,
  failure,
  dependencies: [...dependencies, WorkflowService],
}).annotate(Tool.Readonly, true);

export const BotsToolkit = Toolkit.make(Delegate, Respond, Ask, List, Wait, Answer, StageHandoff);
