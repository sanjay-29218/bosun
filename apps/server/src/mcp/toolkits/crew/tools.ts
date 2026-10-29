import {
  FeatureCardState,
  IssueDetail,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  RepositoryIssue,
  Ticket,
  WorkflowStageHandoff,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { BotProjects } from "../../../bots/BotProjects.ts";
import { CrewHandoffService } from "../../../crew/CrewHandoffService.ts";
import { CrewHandoffStore } from "../../../crew/CrewHandoffStore.ts";
import { CrewStore } from "../../../crew/CrewStore.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as IssueService from "../../../issues/IssueService.ts";
import { TicketService } from "../../../tickets/TicketService.ts";
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

const LinkIssue = Tool.make("crew_link_issue", {
  description:
    "Link the issue the feature you work on tracks: an issue URL, such as one you just created, or a Bosun ticket as `T-14`. A feature has one issue: linking another replaces it, and null unlinks it. Every thread of the feature shows it.",
  parameters: Schema.Struct({ url: Schema.NullOr(Schema.String) }),
  success: Schema.Struct({
    featureId: Schema.String,
    issue: Schema.NullOr(Schema.Struct({ number: Schema.Int, title: Schema.String })),
  }),
  failure,
  dependencies: [...dependencies, FeatureService],
}).annotate(Tool.Destructive, false);

const ListIssues = Tool.make("crew_list_issues", {
  description:
    "List the todos of the project this thread works in: its GitHub issues and its Bosun tickets (`T-<number>`). Open ones by default, newest activity first, with each issue's milestone, parent issue and sub-issue progress. Filter by state or milestone title; tickets have no milestone. `unavailable` says why there are no issues to read, such as a remote not on GitHub.",
  parameters: Schema.Struct({
    state: Schema.optional(Schema.Literals(["open", "closed", "all"])),
    milestone: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Int),
  }),
  success: Schema.Struct({
    repository: Schema.NullOr(Schema.String),
    unavailable: Schema.NullOr(Schema.String),
    /** More open issues exist than the host was asked for. */
    truncated: Schema.Boolean,
    issues: Schema.Array(
      Schema.Struct({
        number: Schema.Int,
        title: Schema.String,
        url: Schema.String,
        state: Schema.Literals(["open", "closed"]),
        milestone: Schema.NullOr(Schema.String),
        parent: Schema.NullOr(Schema.Int),
        subIssues: Schema.NullOr(Schema.Struct({ completed: Schema.Int, total: Schema.Int })),
        labels: Schema.Array(Schema.String),
        assignees: Schema.Array(Schema.String),
      }),
    ),
    tickets: Schema.Array(
      Schema.Struct({
        ref: Schema.String,
        title: Schema.String,
        state: Schema.Literals(["open", "closed"]),
      }),
    ),
  }),
  failure,
  dependencies: [...dependencies, IssueService.IssueService, TicketService],
}).annotate(Tool.Readonly, true);

/** `T-14` names a ticket; `#482` or `482` names an issue. */
const TodoRef = Schema.String.annotate({
  description: "`T-<number>` for a Bosun ticket, `#<number>` for a GitHub issue.",
});

const CreateTodo = Tool.make("crew_create_todo", {
  description:
    "Create a todo in the project this thread works in. `as: ticket` (the default) keeps it in Bosun as `T-<number>`; `as: issue` files a GitHub issue, which needs a GitHub remote. The description is Markdown.",
  parameters: Schema.Struct({
    title: Schema.String,
    description: Schema.optional(Schema.String),
    as: Schema.optional(Schema.Literals(["ticket", "issue"])),
  }),
  success: Schema.Struct({
    ref: Schema.String,
    title: Schema.String,
    url: Schema.NullOr(Schema.String),
  }),
  failure,
  dependencies: [...dependencies, IssueService.IssueService, TicketService],
}).annotate(Tool.Destructive, false);

const ReadTodo = Tool.make("crew_read_todo", {
  description:
    "Read one todo of the project this thread works in, with its Markdown description; a GitHub issue also comes with its first comments.",
  parameters: Schema.Struct({ ref: TodoRef }),
  success: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ticket"), ticket: Ticket }),
    Schema.Struct({ kind: Schema.Literal("issue"), issue: IssueDetail }),
  ]),
  failure,
  dependencies: [...dependencies, IssueService.IssueService, TicketService],
}).annotate(Tool.Readonly, true);

const UpdateTodo = Tool.make("crew_update_todo", {
  description:
    "Close or reopen a todo of the project this thread works in, or change a ticket's title or Markdown description. A GitHub issue's title and description are edited on GitHub.",
  parameters: Schema.Struct({
    ref: TodoRef,
    state: Schema.optional(Schema.Literals(["open", "closed"])),
    closedReason: Schema.optional(Schema.Literals(["completed", "not_planned"])),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
  }),
  success: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("ticket"), ticket: Ticket }),
    Schema.Struct({ kind: Schema.Literal("issue"), issue: RepositoryIssue }),
  ]),
  failure,
  dependencies: [...dependencies, IssueService.IssueService, TicketService],
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
  LinkIssue,
  ListIssues,
  CreateTodo,
  ReadTodo,
  UpdateTodo,
);
