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
import { FeatureWorkspacesLive } from "./FeatureWorkspaces.ts";
import { CrewDelegation } from "../mcp/CrewDelegation.ts";
import { FeatureService, FeatureServiceLive } from "./FeatureService.ts";
import * as FeatureReportReactor from "./FeatureReportReactor.ts";
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
    return CrewDelegation.of({
      member: features.crewMember,
      names: features.crewMemberNames,
      resolveIssue: features.resolveIssue,
    });
  }),
);

/** A child feature that goes quiet without reporting tells its parent's lead anyway. */
const ChildFeatureWatchLive = Layer.effectDiscard(
  FeatureService.pipe(Effect.flatMap((features) => features.watchChildren())),
);

/** A feature started outside a feature hears its lead each time it stops. */
const FeatureReportsLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* FeatureReportReactor.FeatureReportReactor;
    yield* reactor.start();
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

/** Needs `ProjectService` from the orchestration runtime, which `BotService` moves projects with. */
export const FeatureRuntimeLive = Layer.mergeAll(
  TicketService.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(FeatureServiceLive, IssueService.layer)),
  ),
  CrewDelegationLive.pipe(Layer.provide(FeatureServiceLive)),
  ChildFeatureWatchLive.pipe(Layer.provide(FeatureServiceLive)),
  BotService.layer,
  BotAutomationsLive,
  FeatureReportsLive,
  RetiredWorkflowQuestionsLive,
  FeatureManagerTitlesLive,
).pipe(
  Layer.provideMerge(FeatureWorkspacesLive),
  Layer.provideMerge(CrewRuntimeLive),
  // One counter for bots, the Library and features, which ws.ts streams to clients.
  Layer.provideMerge(CrewChangesLive),
);
