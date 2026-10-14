import * as Layer from "effect/Layer";

import { CrewRuntimeLive } from "../crew/runtimeLayer.ts";
import { WorkflowServiceLive } from "./WorkflowService.ts";
import { WorkflowExecutionServiceLive } from "./WorkflowExecutionService.ts";
import { WorkflowExecutionStoreLive } from "./WorkflowExecutionStore.ts";
import { WorkflowStageHandoffStoreLive } from "./WorkflowStageHandoffStore.ts";
import { WorkflowStoreLive } from "./WorkflowStore.ts";

const WorkflowFoundationLive = WorkflowServiceLive.pipe(
  Layer.provideMerge(WorkflowStoreLive),
  Layer.provideMerge(WorkflowStageHandoffStoreLive),
  Layer.provideMerge(CrewRuntimeLive),
);

/** Needs `WorkflowWorkspace`, which reads the app's VCS and checkpoint services. */
export const WorkflowRuntimeLive = WorkflowExecutionServiceLive.pipe(
  Layer.provideMerge(WorkflowExecutionStoreLive),
  Layer.provideMerge(WorkflowFoundationLive),
);
