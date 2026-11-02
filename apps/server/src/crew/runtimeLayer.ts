import * as Layer from "effect/Layer";

import * as BotStore from "../bots/BotStore.ts";
import { WorkflowLibraryLive } from "../workflows/WorkflowLibrary.ts";
import { CrewServiceLive } from "./CrewService.ts";
import { CrewStoreLive } from "./CrewStore.ts";
import { CrewThreadRuntimeV2 } from "./CrewThreadRuntime.ts";

export const CrewRuntimeLive = CrewServiceLive.pipe(
  Layer.provideMerge(CrewStoreLive),
  Layer.provideMerge(CrewThreadRuntimeV2),
  Layer.provideMerge(BotStore.layer),
  Layer.provideMerge(WorkflowLibraryLive),
);
