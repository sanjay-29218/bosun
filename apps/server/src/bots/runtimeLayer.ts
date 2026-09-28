import * as Layer from "effect/Layer";

import { BotServiceLive } from "./BotService.ts";
import { BotStoreLive } from "./BotStore.ts";
import { BotThreadRuntimeV1 } from "./BotThreadRuntime.ts";

export const BotRuntimeLive = BotServiceLive.pipe(
  Layer.provideMerge(BotStoreLive),
  Layer.provideMerge(BotThreadRuntimeV1),
);
