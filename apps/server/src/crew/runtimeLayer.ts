import * as Layer from "effect/Layer";

import * as BotStore from "../bots/BotStore.ts";
import { FeatureWorkspacesLive } from "../features/FeatureWorkspaces.ts";
import { WorkflowLibraryLive } from "../workflows/WorkflowLibrary.ts";
import { CrewServiceLive } from "./CrewService.ts";
import { CrewStoreLive } from "./CrewStore.ts";
import { CrewThreadRuntimeV2 } from "./CrewThreadRuntime.ts";
import { CrewHandoffServiceLive } from "./CrewHandoffService.ts";
import { CrewHandoffStoreLive } from "./CrewHandoffStore.ts";

const CrewFoundationLive = CrewServiceLive.pipe(
  Layer.provideMerge(CrewStoreLive),
  Layer.provideMerge(CrewThreadRuntimeV2),
  Layer.provideMerge(BotStore.layer),
  Layer.provideMerge(WorkflowLibraryLive),
);

export const CrewRuntimeLive = CrewHandoffServiceLive.pipe(
  Layer.provideMerge(CrewHandoffStoreLive),
  Layer.provideMerge(FeatureWorkspacesLive),
  Layer.provideMerge(CrewFoundationLive),
);
