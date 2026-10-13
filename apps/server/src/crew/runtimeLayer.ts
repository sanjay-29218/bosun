import * as Layer from "effect/Layer";

import { CrewServiceLive } from "./CrewService.ts";
import { CrewStoreLive } from "./CrewStore.ts";
import { CrewThreadRuntimeV2 } from "./CrewThreadRuntime.ts";
import { CrewHandoffServiceLive } from "./CrewHandoffService.ts";
import { CrewHandoffStoreLive } from "./CrewHandoffStore.ts";

const CrewFoundationLive = CrewServiceLive.pipe(
  Layer.provideMerge(CrewStoreLive),
  Layer.provideMerge(CrewThreadRuntimeV2),
);

export const CrewRuntimeLive = CrewHandoffServiceLive.pipe(
  Layer.provideMerge(CrewHandoffStoreLive),
  Layer.provideMerge(CrewFoundationLive),
);
