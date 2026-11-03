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
import { FeatureWorkspacesLive } from "./FeatureWorkspaces.ts";
import { CrewDelegation } from "../mcp/CrewDelegation.ts";
import { FeatureService, FeatureServiceLive } from "./FeatureService.ts";

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

/** `delegate_task` reaches a feature's crew through the feature service. */
const CrewDelegationLive = Layer.effect(
  CrewDelegation,
  Effect.gen(function* () {
    const features = yield* FeatureService;
    return CrewDelegation.of({ member: features.crewMember, names: features.crewMemberNames });
  }),
);

/** A child feature that goes quiet without reporting tells its parent's lead anyway. */
const ChildFeatureWatchLive = Layer.effectDiscard(
  FeatureService.pipe(Effect.flatMap((features) => features.watchChildren())),
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
).pipe(
  Layer.provideMerge(FeatureWorkspacesLive),
  Layer.provideMerge(CrewRuntimeLive),
  // One counter for bots, the Library and features, which ws.ts streams to clients.
  Layer.provideMerge(CrewChangesLive),
);
