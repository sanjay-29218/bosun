import * as Layer from "effect/Layer";

import { BotServiceLive } from "./BotService.ts";
import { BotStoreLive } from "./BotStore.ts";
import { BotThreadRuntimeV2 } from "./BotThreadRuntime.ts";
import { BotHandoffServiceLive } from "./BotHandoffService.ts";
import { BotHandoffStoreLive } from "./BotHandoffStore.ts";

const BotFoundationLive = BotServiceLive.pipe(
  Layer.provideMerge(BotStoreLive),
  Layer.provideMerge(BotThreadRuntimeV2),
);

export const BotRuntimeLive = BotHandoffServiceLive.pipe(
  Layer.provideMerge(BotHandoffStoreLive),
  Layer.provideMerge(BotFoundationLive),
);
