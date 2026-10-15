import * as Layer from "effect/Layer";

import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { FeatureExecutionServiceLive } from "./FeatureExecutionService.ts";
import { WorktreeBootstrapServiceLive } from "../project/WorktreeBootstrapService.ts";
import { FeatureServiceLive } from "./FeatureService.ts";
import { FeatureLaunchStoreLive } from "./FeatureLaunchStore.ts";
import { FeatureLaunchServiceLive } from "./FeatureLaunchService.ts";

export const FeatureRuntimeLive = Layer.merge(
  FeatureLaunchServiceLive,
  FeatureExecutionServiceLive,
).pipe(
  Layer.provideMerge(WorktreeBootstrapServiceLive),
  Layer.provideMerge(FeatureServiceLive),
  Layer.provideMerge(FeatureLaunchStoreLive),
  Layer.provideMerge(WorkflowRuntimeLive),
);
