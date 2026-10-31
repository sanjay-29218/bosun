import {
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ticketRef,
  type RepositoryIssue,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CrewHandoffService } from "../../../crew/CrewHandoffService.ts";
import { CrewHandoffStore } from "../../../crew/CrewHandoffStore.ts";
import { CrewStore } from "../../../crew/CrewStore.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as IssueService from "../../../issues/IssueService.ts";
import { TicketService } from "../../../tickets/TicketService.ts";
import { ticketNumberFromRef } from "../../../tickets/ticketRows.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CrewToolFailedError, CrewToolkit } from "./tools.ts";

const isAccessError = Schema.is(
  Schema.Union([McpCapabilityUnavailableError, OrchestratorMcpFailure]),
);

/** Crew tools act for the crew run behind the calling thread, so only thread callers have one. */
const requireCrewThread = McpInvocationContext.requireMcpCapability("crew").pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This crew tool")),
  Effect.map((scope) => scope.thread.threadId),
);

/** `T-14` is a ticket, `#482` or `482` an issue. */
function parseTodoRef(ref: string) {
  const ticket = ticketNumberFromRef(ref);
  if (ticket !== null) return { kind: "ticket", number: ticket } as const;
  const issue = /^\s*#?([1-9]\d*)\s*$/u.exec(ref);
  return issue ? ({ kind: "issue", number: Number(issue[1]) } as const) : null;
}

const ISSUE_ROWS_DEFAULT = 30;
const ISSUE_ROWS_MAX = 100;

/** Compact rows of the issues a crew member asked for, filtered by state and milestone title. */
function crewIssueRows(
  issues: ReadonlyArray<RepositoryIssue>,
  input: {
    readonly state?: "open" | "closed" | "all" | undefined;
    readonly milestone?: string | undefined;
    readonly limit?: number | undefined;
  },
) {
  const state = input.state ?? "open";
  const milestone = input.milestone?.trim().toLowerCase();
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? ISSUE_ROWS_DEFAULT), 1),
    ISSUE_ROWS_MAX,
  );
  return issues
    .filter(
      (issue) =>
        (state === "all" || issue.state === state) &&
        (!milestone || issue.milestone?.title.toLowerCase() === milestone),
    )
    .slice(0, limit)
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      state: issue.state,
      milestone: issue.milestone?.title ?? null,
      parent: issue.parent,
      subIssues: issue.subIssues,
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees.map((assignee) => assignee.login),
    }));
}

const make = Effect.gen(function* () {
  const handoffs = yield* CrewHandoffService;
  const handoffStore = yield* CrewHandoffStore;
  const crewStore = yield* CrewStore;
  const workflows = yield* WorkflowService;
  const features = yield* FeatureService;
  const issues = yield* IssueService.IssueService;
  const tickets = yield* TicketService;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const threadProject = Effect.fn("CrewToolkit.threadProject")(function* (
    threadId: McpInvocationContext.McpThreadCaller["threadId"],
  ) {
    const shell = yield* threads.getThreadShell(threadId);
    if (!shell) return yield* new CrewToolFailedError({ reason: "This thread has no project" });
    return shell.projectId;
  });

  const todoRef = Effect.fn("CrewToolkit.todoRef")(function* (ref: string) {
    const parsed = parseTodoRef(ref);
    if (!parsed) {
      return yield* new CrewToolFailedError({
        reason: "Name a todo as T-<number> for a ticket or #<number> for an issue",
      });
    }
    return parsed;
  });

  const asCrewMember = <A, E, R>(
    effect: (threadId: McpInvocationContext.McpThreadCaller["threadId"]) => Effect.Effect<A, E, R>,
  ) =>
    requireCrewThread.pipe(
      Effect.flatMap(effect),
      Effect.mapError((error) =>
        isAccessError(error) ? error : new CrewToolFailedError({ reason: String(error) }),
      ),
    );

  return {
    crew_link_issue: McpToolAccess.actsAsCaller((input: { readonly url: string | null }) =>
      asCrewMember((threadId) =>
        features.setIssueForThread(threadId, input.url).pipe(
          Effect.map((feature) => ({
            featureId: feature.id,
            issue: feature.issue && { number: feature.issue.number, title: feature.issue.title },
          })),
        ),
      ),
    ),
    crew_list_issues: McpToolAccess.readsAsCaller(
      (input: {
        readonly state?: "open" | "closed" | "all" | undefined;
        readonly milestone?: string | undefined;
        readonly limit?: number | undefined;
      }) =>
        asCrewMember((threadId) =>
          Effect.gen(function* () {
            const projectId = yield* threadProject(threadId);
            const [list, projectTickets] = yield* Effect.all(
              [issues.list(projectId), tickets.list(projectId)],
              { concurrency: 2 },
            );
            const state = input.state ?? "open";
            return {
              repository: list.repository,
              unavailable: list.unavailable,
              truncated: list.truncated,
              issues: crewIssueRows(list.issues, input),
              tickets: input.milestone
                ? []
                : projectTickets
                    .filter((ticket) => state === "all" || ticket.state === state)
                    .map((ticket) => ({
                      ref: ticketRef(ticket),
                      title: ticket.title,
                      state: ticket.state,
                    })),
            };
          }),
        ),
    ),
    crew_create_todo: McpToolAccess.actsAsCaller(
      (input: {
        readonly title: string;
        readonly description?: string | undefined;
        readonly as?: "ticket" | "issue" | undefined;
      }) =>
        asCrewMember((threadId) =>
          Effect.gen(function* () {
            const projectId = yield* threadProject(threadId);
            const description = input.description ?? "";
            if (input.as === "issue") {
              const issue = yield* issues.create({
                projectId,
                title: input.title,
                body: description,
              });
              return { ref: `#${issue.number}`, title: issue.title, url: issue.url };
            }
            const ticket = yield* tickets.create({ projectId, title: input.title, description });
            return { ref: ticketRef(ticket), title: ticket.title, url: null };
          }),
        ),
    ),
    crew_read_todo: McpToolAccess.readsAsCaller((input: { readonly ref: string }) =>
      asCrewMember((threadId) =>
        Effect.gen(function* () {
          const projectId = yield* threadProject(threadId);
          const ref = yield* todoRef(input.ref);
          if (ref.kind === "ticket") {
            return {
              kind: "ticket",
              ticket: yield* tickets.getByNumber(projectId, ref.number),
            } as const;
          }
          return { kind: "issue", issue: yield* issues.get(projectId, ref.number) } as const;
        }),
      ),
    ),
    crew_update_todo: McpToolAccess.actsAsCaller(
      (input: {
        readonly ref: string;
        readonly state?: "open" | "closed" | undefined;
        readonly closedReason?: "completed" | "not_planned" | undefined;
        readonly title?: string | undefined;
        readonly description?: string | undefined;
      }) =>
        asCrewMember((threadId) =>
          Effect.gen(function* () {
            const projectId = yield* threadProject(threadId);
            const ref = yield* todoRef(input.ref);
            if (ref.kind === "ticket") {
              const ticket = yield* tickets.getByNumber(projectId, ref.number);
              const updated = yield* tickets.update({
                projectId,
                ticketId: ticket.id,
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.description === undefined ? {} : { description: input.description }),
                ...(input.state === undefined ? {} : { state: input.state }),
                ...(input.closedReason === undefined ? {} : { closedReason: input.closedReason }),
              });
              return { kind: "ticket", ticket: updated } as const;
            }
            if (input.title !== undefined || input.description !== undefined) {
              return yield* new CrewToolFailedError({
                reason: "A GitHub issue's title and description are edited on GitHub",
              });
            }
            if (input.state === undefined) {
              return yield* new CrewToolFailedError({ reason: "Pass the state to change to" });
            }
            const issue = yield* issues.setState({
              projectId,
              number: ref.number,
              state: input.state,
              reason: input.closedReason,
            });
            return { kind: "issue", issue } as const;
          }),
        ),
    ),
    crew_respond: McpToolAccess.actsAsCaller(
      (input: { readonly outcome: "completed" | "failed"; readonly summary: string }) =>
        asCrewMember((threadId) => handoffs.respond(threadId, input.outcome, input.summary)),
    ),
    crew_ask: McpToolAccess.actsAsCaller((input: { readonly question: string }) =>
      asCrewMember((threadId) => handoffs.ask(threadId, input.question)),
    ),
    crew_stage_handoff: McpToolAccess.readsAsCaller(() =>
      asCrewMember((threadId) =>
        Effect.gen(function* () {
          const runId = yield* handoffStore.getRunByThread(threadId);
          const run = runId ? yield* crewStore.getRun(runId) : null;
          if (!run?.allowedTools.includes("crew.respond")) {
            return yield* new CrewToolFailedError({
              reason: "Caller is not a workflow stage member",
            });
          }
          const record = yield* workflows.getStageHandoffForThread(run.projectId, threadId);
          if (!record) {
            return yield* new CrewToolFailedError({
              reason: "This run did not start from a workflow stage",
            });
          }
          return record;
        }),
      ),
    ),
    crew_answer: McpToolAccess.actsAsCaller(
      (input: { readonly requestId: string; readonly answer: string }) =>
        asCrewMember((threadId) => handoffs.answerFromBot(threadId, input.requestId, input.answer)),
    ),
  };
});

export const layer = McpToolAccess.toLayer(CrewToolkit, make);
