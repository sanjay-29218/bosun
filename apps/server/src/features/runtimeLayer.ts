import { ScheduledTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as BotService from "../bots/BotService.ts";
import { CrewService } from "../crew/CrewService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TicketService from "../tickets/TicketService.ts";
import { CrewChangesLive } from "../crew/CrewChanges.ts";
import { CrewRuntimeLive } from "../crew/runtimeLayer.ts";
import { dismissRetiredWorkflowQuestions } from "../crew/retiredWorkflowQuestions.ts";
import { retitleFeatureManagerLeads } from "./featureManagerTitles.ts";
import * as ProjectRequests from "../crew/ProjectRequests.ts";
import * as MergeNotices from "../crew/MergeNotices.ts";
import { FeatureWorkspacesLive } from "./FeatureWorkspaces.ts";
import { CrewDelegation } from "../mcp/CrewDelegation.ts";
import { FeatureService, FeatureServiceLive } from "./FeatureService.ts";
import * as FeatureReportReactor from "./FeatureReportReactor.ts";
import * as NoticeInbox from "./NoticeInbox.ts";
import { forkParked } from "../serverActivation.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { OrchestrationEventStore } from "../persistence/OrchestrationEventStore.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * Automations that run as a bot post into its headquarters, which the crew opens or restores.
 * Bot tasks filed before bots had homes move into them.
 */
const BotAutomationsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const crew = yield* CrewService;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    yield* scheduledTasks.rehomeBotTasks().pipe(
      Effect.catch((cause) => Effect.logWarning("Bot tasks stayed outside homes", { cause })),
      forkParked,
    );
    yield* scheduledTasks.connectBotHeadquarters((botId) =>
      crew.ensureHeadquarters(botId).pipe(
        Effect.map((run) => ({ threadId: run.threadId, projectId: run.projectId })),
        Effect.mapError(
          (cause) =>
            new ScheduledTaskError({
              // Crew refusals, such as a bot without a model, are written for the user.
              message:
                cause._tag === "CrewValidationError"
                  ? `Could not open the bot's headquarters: ${cause.message}`
                  : "Could not open the bot's headquarters.",
              cause,
            }),
        ),
      ),
    );
  }),
);

/**
 * Automations that run as a project's manager post into its thread, which the crew opens. They
 * stop when the manager is off, and go with their project when it is deleted.
 */
const ProjectManagerAutomationsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const crew = yield* CrewService;
    const projects = yield* ProjectService.ProjectService;
    const events = yield* OrchestrationEventStore;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    const managerError = (cause: { readonly _tag: string; readonly message: string }) =>
      new ScheduledTaskError({
        message:
          cause._tag === "CrewValidationError"
            ? cause.message
            : "Could not reach the project's manager.",
        cause,
      });
    yield* scheduledTasks.connectProjectManagers({
      status: Effect.fn("ProjectManagerAutomations.status")(function* (projectId) {
        const project = yield* projects.getShell(projectId);
        if (Option.isNone(project)) return null;
        yield* crew.requireManagedProject(projectId);
        const enabled = yield* crew
          .requireProjectManagerOn(projectId)
          .pipe(
            Effect.as(true),
            Effect.catchTags({ CrewValidationError: () => Effect.succeed(false) }),
          );
        return { title: project.value.title, enabled };
      }, Effect.mapError(managerError)),
      open: (projectId) =>
        crew.ensureProjectManager(projectId).pipe(
          Effect.map((run) => ({ threadId: run.threadId, projectId })),
          Effect.mapError(managerError),
        ),
    });
    const sweep = scheduledTasks
      .deleteForDeletedProjects()
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Deleted projects' manager automations stayed", { cause }),
        ),
      );
    yield* forkParked(
      Stream.runForEach(
        Stream.unwrap(
          events.latestApplicationSequence.pipe(
            Effect.map((afterSequence) =>
              events.streamProjectedApplicationEvents({
                afterSequence,
                project: (event) => event,
                filter: (event) =>
                  "aggregateKind" in event &&
                  event.aggregateKind === "project" &&
                  event.type === "project.deleted",
              }),
            ),
          ),
        ),
        () => sweep,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Project deletion stream for automations failed", { cause }),
        ),
      ),
    );
    // Catches deletions from while the server was down.
    yield* forkParked(sweep);
  }),
);

/** `delegate_task` reaches a feature's crew, and links issues, through the feature service. */
const CrewDelegationLive = Layer.effect(
  CrewDelegation,
  Effect.gen(function* () {
    const features = yield* FeatureService;
    const requests = yield* ProjectRequests.ProjectRequests;
    return CrewDelegation.of({
      member: features.crewMember,
      names: features.crewMemberNames,
      resolveIssue: features.resolveIssue,
      hasRequest: Effect.fn("CrewDelegation.hasRequest")(function* (projectId, requestId) {
        return (yield* requests.get(projectId, requestId)) !== null;
      }),
    });
  }),
);

/** Notices held for a busy thread reach it as one message once it is free. */
const NoticeInboxWatchLive = Layer.effectDiscard(
  NoticeInbox.NoticeInbox.pipe(Effect.flatMap((inbox) => inbox.start())),
);

/**
 * A feature that goes quiet tells its parent's lead or whoever started it, and when its lead
 * waits on the person; start-up catches up on every kind of notice in one pass.
 */
const FeatureReportsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* FeatureReportReactor.FeatureReportReactor;
    const features = yield* FeatureService;
    // In order: the watches record where they start, then catch-up scans what came before.
    yield* features.watchChildren();
    yield* reactor.start();
    yield* forkParked(FeatureReportReactor.catchUpAtStartup());
  }),
).pipe(
  Layer.provide(FeatureReportReactor.layer),
  Layer.provide(Layer.merge(FeatureServiceLive, ProjectionStore.layer)),
);

const RetiredWorkflowQuestionsLive = Layer.effectDiscard(
  dismissRetiredWorkflowQuestions().pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not dismiss retired workflow questions", { cause }),
    ),
  ),
);

const FeatureManagerTitlesLive = Layer.effectDiscard(
  retitleFeatureManagerLeads().pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not retitle feature leads", { cause })),
  ),
);

const ProjectRequestsLive = ProjectRequests.layer.pipe(Layer.provide(ProjectionStore.layer));

/** Requests post to their project's manager; its turns that end unanswered are answered. */
const ProjectRequestsWatchLive = Layer.effectDiscard(
  ProjectRequests.ProjectRequests.pipe(Effect.flatMap((requests) => requests.start())),
);

/** A project's manager hears once when its tracked work's pull request merges. */
const MergeNoticesLive = Layer.effectDiscard(
  MergeNotices.MergeNotices.pipe(Effect.flatMap((notices) => notices.start())),
).pipe(
  Layer.provide(MergeNotices.layer),
  Layer.provide(TicketService.layer),
  Layer.provide(Layer.mergeAll(FeatureServiceLive, IssueService.layer, ProjectionStore.layer)),
);

/** Needs `ProjectService` from the orchestration runtime, which `BotService` moves projects with. */
export const FeatureRuntimeLive = Layer.mergeAll(
  TicketService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(FeatureServiceLive, IssueService.layer)),
  ),
  CrewDelegationLive.pipe(Layer.provide(Layer.merge(FeatureServiceLive, ProjectRequestsLive))),
  BotService.layer,
  BotAutomationsLive,
  ProjectManagerAutomationsLive,
  FeatureReportsLive,
  RetiredWorkflowQuestionsLive,
  FeatureManagerTitlesLive,
  ProjectRequestsWatchLive.pipe(Layer.provideMerge(ProjectRequestsLive)),
  MergeNoticesLive,
  NoticeInboxWatchLive,
).pipe(
  Layer.provideMerge(NoticeInbox.layer),
  Layer.provideMerge(FeatureWorkspacesLive),
  Layer.provideMerge(CrewRuntimeLive),
  // One counter for bots, the Library and features, which ws.ts streams to clients.
  Layer.provideMerge(CrewChangesLive),
);
