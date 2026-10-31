import {
  IssueDetail,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  RepositoryIssue,
  FeatureCardState,
  Ticket,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { FeatureService } from "../../../features/FeatureService.ts";
import * as IssueService from "../../../issues/IssueService.ts";
import { TicketService } from "../../../tickets/TicketService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowExecutionService } from "../../../workflows/WorkflowExecutionService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

export class CrewToolFailedError extends Schema.TaggedError<CrewToolFailedError>()(
  "CrewToolFailedError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const dependencies = [McpInvocationContext, ThreadManagementService.ThreadManagementService];
/** What a crew tool fails with, including the access gate's refusal. */
const failure = Schema.Union([
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  CrewToolFailedError,
]);
/** What a workflow stage's report recorded. */
const StageReport = Schema.Struct({
  stepId: Schema.String,
  recorded: Schema.Literals(["completed", "question"]),
});

const Respond = Tool.make("crew_respond", {
  description:
    "Report the result of the workflow stage this thread runs: one of the stage's outcomes with a summary of the result and its evidence, or needs_input with the question a person must answer as the summary. Then end your turn; an answer arrives in this thread.",
  parameters: Schema.Struct({
    outcome: Schema.String,
    summary: Schema.String,
  }),
  success: StageReport,
  failure,
  dependencies: [...dependencies, WorkflowExecutionService],
}).annotate(Tool.Idempotent, true);

const Decide = Tool.make("crew_decide", {
  description:
    "Decide for a feature stage you lead, when its workflow lets the lead decide and the stage's request arrived in this thread. approve passes the stage's gate; request_changes sends the stage back to rework with text saying what to change; answer replies to the stage's question with text. Pass the featureId the request named. Whoever decides first, you or a person, wins.",
  parameters: Schema.Struct({
    featureId: Schema.optional(Schema.String),
    decision: Schema.Literals(["approve", "request_changes", "answer"]),
    text: Schema.optional(Schema.String),
  }),
  /** Where the feature stands after the decision. */
  success: Schema.Struct({
    featureId: Schema.String,
    activeStepId: Schema.NullOr(Schema.String),
    state: Schema.optional(FeatureCardState),
  }),
  failure,
  dependencies: [...dependencies, WorkflowExecutionService],
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
  Respond,
  Decide,
  LinkIssue,
  ListIssues,
  CreateTodo,
  ReadTodo,
  UpdateTodo,
);
