import {
  FeatureCardState,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  WorkflowStageHandoff,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { BotProjects } from "../../../bots/BotProjects.ts";
import { CrewHandoffService } from "../../../crew/CrewHandoffService.ts";
import { CrewHandoffStore } from "../../../crew/CrewHandoffStore.ts";
import { CrewStore } from "../../../crew/CrewStore.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class CrewToolFailedError extends Schema.TaggedError<CrewToolFailedError>()(
  "CrewToolFailedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const dependencies = [
  McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  CrewHandoffService,
  CrewHandoffStore,
  CrewStore,
];
/** What a crew tool fails with, including the access gate's refusal. */
const failure = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  CrewToolFailedError,
]);
const Handoff = Schema.Struct({
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  sourceRunId: Schema.String,
  targetMemberId: Schema.String,
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

const Delegate = Tool.make("crew_delegate", {
  description:
    "Hand a bounded project task to a permitted crew member. A bot can hand work to the manager of any project it owns (projectManagerId from crew_list_projects). Reuse the same request ID when retrying after a lost response.",
  parameters: Schema.Struct({
    requestId: Schema.String,
    targetMemberId: Schema.String,
    taskText: Schema.String,
    contextText: Schema.optional(Schema.String),
  }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, true);

const Respond = Tool.make("crew_respond", {
  description:
    "Report a structured completed or failed outcome for the handoff that started this crew run.",
  parameters: Schema.Struct({
    outcome: Schema.Literals(["completed", "failed"]),
    summary: Schema.String,
  }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, true);

const Ask = Tool.make("crew_ask", {
  description:
    "Pause this handoff with a question for the requester. The question remains durable until answered or cancelled.",
  parameters: Schema.Struct({ question: Schema.String }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, true);

const List = Tool.make("crew_list_handoffs", {
  description:
    "List the requests delegated by this crew run and their current structured outcomes.",
  success: Schema.Struct({ handoffs: Schema.Array(Handoff) }),
  failure,
  dependencies,
}).annotate(Tool.Readonly, true);

const Wait = Tool.make("crew_wait_handoff", {
  description:
    "Wait up to 30 seconds for one handoff you delegated to finish or ask a question. Call again with the same request ID while it is still running.",
  parameters: Schema.Struct({ requestId: Schema.String }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Readonly, true);

const Answer = Tool.make("crew_answer", {
  description:
    "Answer a question from a handoff this crew member delegated. The recipient resumes in its linked T3 thread.",
  parameters: Schema.Struct({ requestId: Schema.String, answer: Schema.String }),
  success: Handoff,
  failure,
  dependencies,
}).annotate(Tool.Idempotent, false);

const StageHandoff = Tool.make("crew_stage_handoff", {
  description:
    "Read the full handoff this workflow stage started from: the brief, the outputs it receives, notes from earlier stages and people, and the branch and commit. Nothing else is passed between stages.",
  success: WorkflowStageHandoff,
  failure,
  dependencies: [...dependencies, WorkflowService],
}).annotate(Tool.Readonly, true);

const BotProject = Schema.Struct({
  projectId: Schema.String,
  title: Schema.String,
  workspaceRoot: Schema.String,
  projectManagerId: Schema.String,
  features: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      title: Schema.String,
      state: FeatureCardState,
      stage: Schema.NullOr(Schema.String),
    }),
  ),
});

const ListProjects = Tool.make("crew_list_projects", {
  description:
    "List the projects this bot owns, with each project's manager and its features. Hand a project work by delegating to its projectManagerId.",
  success: Schema.Struct({ projects: Schema.Array(BotProject) }),
  failure,
  dependencies: [...dependencies, BotProjects],
}).annotate(Tool.Readonly, true);

const CreateProject = Tool.make("crew_create_project", {
  description:
    "Start a project this bot owns: a fresh Git repository named `name`, or a clone of `repositoryUrl` named `name`. Returns it with its manager.",
  parameters: Schema.Struct({
    name: Schema.String,
    repositoryUrl: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    ...BotProject.fields,
    commitError: Schema.optional(Schema.String),
  }),
  failure,
  dependencies: [...dependencies, BotProjects],
}).annotate(Tool.Destructive, false);

export const CrewToolkit = Toolkit.make(
  Delegate,
  Respond,
  Ask,
  List,
  Wait,
  Answer,
  StageHandoff,
  ListProjects,
  CreateProject,
);
