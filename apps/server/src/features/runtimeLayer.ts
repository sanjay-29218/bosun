import * as Layer from "effect/Layer";

import * as BotProjects from "../bots/BotProjects.ts";
import * as BotService from "../bots/BotService.ts";
import * as IssueService from "../issues/IssueService.ts";
import * as TicketService from "../tickets/TicketService.ts";
import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { FeatureServiceLive } from "./FeatureService.ts";

/**
 * Needs `ProjectService` from the orchestration runtime, which `BotService` moves projects with,
 * and the managed folders and clone service `BotProjects` starts projects with.
 */
export const FeatureRuntimeLive = Layer.mergeAll(
  Layer.mergeAll(BotProjects.layer, TicketService.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(FeatureServiceLive, IssueService.layer)),
  ),
  BotService.layer,
).pipe(Layer.provideMerge(WorkflowRuntimeLive));
