import * as Layer from "effect/Layer";

import * as BotService from "../bots/BotService.ts";
import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { FeatureServiceLive } from "./FeatureService.ts";

/** Needs `ProjectService` from the orchestration runtime, which `BotService` moves projects with. */
export const FeatureRuntimeLive = Layer.mergeAll(FeatureServiceLive, BotService.layer).pipe(
  Layer.provideMerge(WorkflowRuntimeLive),
);
