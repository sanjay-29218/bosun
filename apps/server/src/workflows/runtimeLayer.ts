import * as Layer from "effect/Layer";

import { BotRuntimeLive } from "../bots/runtimeLayer.ts";
import { WorkflowServiceLive } from "./WorkflowService.ts";
import { WorkflowStoreLive } from "./WorkflowStore.ts";

export const WorkflowRuntimeLive = WorkflowServiceLive.pipe(
  Layer.provideMerge(WorkflowStoreLive),
  Layer.provideMerge(BotRuntimeLive),
);
