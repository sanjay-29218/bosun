import { ScheduledTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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

/** Automations that run as a bot post into its headquarters, which the crew opens or restores. */
const BotAutomationsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const crew = yield* CrewService;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    yield* scheduledTasks.connectBotHeadquarters((botId) =>
      crew.ensureHeadquarters(botId).pipe(
        Effect.map((run) => ({ threadId: run.threadId, projectId: run.projectId })),
        Effect.mapError(
          (cause) =>
            new ScheduledTaskError({
              // Crew refusals, such as a bot without a project, are written for the user.
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

/** A feature that goes quiet without reporting tells its parent's lead or whoever started it. */
const ChildFeatureWatchLive = Layer.effectDiscard(
  FeatureService.pipe(Effect.flatMap((features) => features.watchChildren())),
);

/** Notices held for a busy thread reach it as one message once it is free. */
const NoticeInboxWatchLive = Layer.effectDiscard(
  NoticeInbox.NoticeInbox.pipe(Effect.flatMap((inbox) => inbox.start())),
);

/**
 * The thread that started a feature hears when its lead waits on the person, and start-up
 * catches up on every kind of notice in one pass.
 */
const FeatureReportsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* FeatureReportReactor.FeatureReportReactor;
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
  Layer.provide(Layer.merge(FeatureServiceLive, ProjectionStore.layer)),
);

/** Needs `ProjectService` from the orchestration runtime, which `BotService` moves projects with. */
export const FeatureRuntimeLive = Layer.mergeAll(
  TicketService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(FeatureServiceLive, IssueService.layer)),
  ),
  CrewDelegationLive.pipe(Layer.provide(Layer.merge(FeatureServiceLive, ProjectRequestsLive))),
  ChildFeatureWatchLive.pipe(Layer.provide(FeatureServiceLive)),
  BotService.layer,
  BotAutomationsLive,
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
