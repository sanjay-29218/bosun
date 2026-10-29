import { ScheduledTaskError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BotProjects from "../bots/BotProjects.ts";
import * as BotService from "../bots/BotService.ts";
import { CrewService } from "../crew/CrewService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TicketService from "../tickets/TicketService.ts";
import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { FeatureServiceLive } from "./FeatureService.ts";

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

/**
 * Needs `ProjectService` from the orchestration runtime, which `BotService` moves projects with,
 * and the managed folders and clone service `BotProjects` starts projects with.
 */
export const FeatureRuntimeLive = Layer.mergeAll(
  Layer.mergeAll(BotProjects.layer, TicketService.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(FeatureServiceLive, IssueService.layer)),
  ),
  BotService.layer,
  BotAutomationsLive,
).pipe(Layer.provideMerge(WorkflowRuntimeLive));
