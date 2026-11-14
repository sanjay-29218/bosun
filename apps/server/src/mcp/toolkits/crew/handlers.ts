import {
  featureIssueRef,
  McpCapabilityUnavailableError,
  OrchestratorMcpFailure,
  ticketRef,
  type ProjectId,
  type RepositoryIssue,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CrewService } from "../../../crew/CrewService.ts";
import { FeatureService } from "../../../features/FeatureService.ts";
import * as IssueService from "../../../issues/IssueService.ts";
import { TicketService } from "../../../tickets/TicketService.ts";
import { ticketNumberFromRef } from "../../../tickets/ticketRows.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CrewToolFailedError, CrewToolkit } from "./tools.ts";

const isAccessError = Schema.is(
  Schema.Union([McpCapabilityUnavailableError, OrchestratorMcpFailure]),
);

/**
 * Crew tools act for the crew run behind the calling thread, so only thread callers have one. A
 * delegated child shares its parent's crew tools but never acts as a standing thread.
 */
const requireCrewCaller = McpInvocationContext.requireMcpCapability("crew").pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This crew tool")),
  Effect.map((scope) => ({
    callerThreadId: scope.thread.threadId,
    callerIsSubagent: scope.thread.subagent === true,
  })),
);
const requireCrewThread = requireCrewCaller.pipe(Effect.map((caller) => caller.callerThreadId));

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
  const parts = new Map<number, number[]>();
  for (const issue of issues) {
    if (issue.parent !== null)
      parts.set(issue.parent, [...(parts.get(issue.parent) ?? []), issue.number]);
  }
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
      subIssues: issue.subIssues && {
        ...issue.subIssues,
        numbers: (parts.get(issue.number) ?? []).toSorted((a, b) => a - b),
      },
      labels: issue.labels.map((label) => label.name),
      assignees: issue.assignees.map((assignee) => assignee.login),
    }));
}

const make = Effect.gen(function* () {
  const crew = yield* CrewService;
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

  const toolFailure = <E>(error: E) =>
    isAccessError(error)
      ? error
      : new CrewToolFailedError({
          reason: error instanceof Error ? error.message : String(error),
        });
  const asCrewMember = <A, E, R>(
    effect: (threadId: McpInvocationContext.McpThreadCaller["threadId"]) => Effect.Effect<A, E, R>,
  ) => requireCrewThread.pipe(Effect.flatMap(effect), Effect.mapError(toolFailure));
  const asCrewCaller = <A, E, R>(
    effect: (caller: Effect.Success<typeof requireCrewCaller>) => Effect.Effect<A, E, R>,
  ) => requireCrewCaller.pipe(Effect.flatMap(effect), Effect.mapError(toolFailure));
  return {
    crew_read_manager_instructions: McpToolAccess.readsAsCaller(
      (input: { readonly projectId?: ProjectId | undefined }) =>
        asCrewCaller((caller) =>
          crew.projectManagerInstructions({ ...caller, projectId: input.projectId }),
        ),
    ),
    crew_update_manager_instructions: McpToolAccess.actsAsCaller(
      (input: {
        readonly projectId?: ProjectId | undefined;
        readonly instructions: string;
        readonly expectedRevision: number;
      }) =>
        asCrewCaller((caller) =>
          crew
            .updateProjectManagerInstructions({ ...caller, ...input })
            .pipe(Effect.map((saved) => ({ ...saved, appliesFrom: "the manager's next session" }))),
        ),
    ),
    crew_link_issue: McpToolAccess.actsAsCaller(
      (input: { readonly url: string | null; readonly threadId?: ThreadId | undefined }) =>
        asCrewMember((callerId) =>
          Effect.gen(function* () {
            const caller = yield* threads.getThreadShell(callerId);
            const target =
              input.threadId === undefined ? caller : yield* threads.getThreadShell(input.threadId);
            if (input.threadId !== undefined && target?.lineage.parentThreadId !== callerId) {
              return yield* new CrewToolFailedError({
                reason: "threadId must be a task this thread delegated",
              });
            }
            if (input.threadId === undefined && caller?.feature) {
              const feature = yield* features.setIssueForThread(callerId, input.url);
              return {
                featureId: feature.id,
                threadId: null,
                issue: feature.issue && {
                  ref: featureIssueRef(feature.issue),
                  title: feature.issue.title,
                },
              };
            }
            const threadId = input.threadId ?? callerId;
            const issue = yield* features.setThreadIssue(threadId, input.url);
            return {
              featureId: null,
              threadId,
              issue: issue && { ref: featureIssueRef(issue), title: issue.title },
            };
          }),
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
        readonly milestone?: string | undefined;
        readonly parent?: number | undefined;
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
                ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
                ...(input.parent === undefined ? {} : { parent: input.parent }),
              });
              return { ref: `#${issue.number}`, title: issue.title, url: issue.url };
            }
            if (input.milestone !== undefined || input.parent !== undefined) {
              return yield* new OrchestratorMcpFailure({
                code: "invalid_request",
                message:
                  "Tickets have no milestone or parent. File it with `as: issue`, or leave them out.",
              });
            }
            const ticket = yield* tickets.create({ projectId, title: input.title, description });
            return { ref: ticketRef(ticket), title: ticket.title, url: null };
          }),
        ),
    ),
    crew_create_milestone: McpToolAccess.actsAsCaller(
      (input: { readonly title: string; readonly description?: string | undefined }) =>
        asCrewMember((threadId) =>
          Effect.gen(function* () {
            const milestone = yield* issues.createMilestone({
              projectId: yield* threadProject(threadId),
              title: input.title,
              ...(input.description === undefined ? {} : { description: input.description }),
            });
            return { number: milestone.number, title: milestone.title, url: milestone.url };
          }),
        ),
    ),
    crew_update_milestone: McpToolAccess.actsAsCaller(
      (input: { readonly milestone: string; readonly state: "open" | "closed" }) =>
        asCrewMember((threadId) =>
          Effect.gen(function* () {
            const milestone = yield* issues.setMilestoneState({
              projectId: yield* threadProject(threadId),
              milestone: input.milestone,
              state: input.state,
            });
            return { number: milestone.number, title: milestone.title, url: milestone.url };
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
        readonly milestone?: string | null | undefined;
        readonly parent?: number | null | undefined;
      }) =>
        asCrewMember((threadId) =>
          Effect.gen(function* () {
            const projectId = yield* threadProject(threadId);
            const ref = yield* todoRef(input.ref);
            const structure = input.milestone !== undefined || input.parent !== undefined;
            if (ref.kind === "ticket" && structure) {
              return yield* new CrewToolFailedError({
                reason: "Tickets have no milestone or parent",
              });
            }
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
            let issue = structure
              ? yield* issues.update({
                  projectId,
                  number: ref.number,
                  ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
                  ...(input.parent === undefined ? {} : { parent: input.parent }),
                })
              : null;
            if (input.state !== undefined) {
              issue = yield* issues.setState({
                projectId,
                number: ref.number,
                state: input.state,
                reason: input.closedReason,
              });
            }
            if (issue === null) {
              return yield* new CrewToolFailedError({
                reason: "Pass the state, milestone or parent to change",
              });
            }
            return { kind: "issue", issue } as const;
          }),
        ),
    ),
  };
});

export const layer = McpToolAccess.toLayer(CrewToolkit, make);
