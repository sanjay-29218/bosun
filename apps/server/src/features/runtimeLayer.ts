import * as Layer from "effect/Layer";

import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { FeatureServiceLive } from "./FeatureService.ts";

export const FeatureRuntimeLive = FeatureServiceLive.pipe(Layer.provideMerge(WorkflowRuntimeLive));
