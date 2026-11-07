import { isStandingThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TurnBriefing from "../orchestration-v2/TurnBriefing.ts";
import { crewRunPrompt } from "./crewPrompts.ts";
import { CrewStore, CrewStoreLive } from "./CrewStore.ts";

/** A bot's headquarters or a project's manager is briefed with its run's instructions and task. */
export const StandingBriefingLive = Layer.effect(
  TurnBriefing.TurnBriefing,
  Effect.gen(function* () {
    const store = yield* CrewStore;
    return TurnBriefing.TurnBriefing.of({
      forThread: Effect.fn("StandingBriefing.forThread")(function* (threadId) {
        if (!isStandingThread(threadId)) return null;
        const run = yield* store
          .getRunByThread(threadId)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Standing thread briefing unavailable", { threadId, error }).pipe(
                Effect.as(null),
              ),
            ),
          );
        return run === null ? null : crewRunPrompt(run);
      }),
    });
  }),
).pipe(Layer.provide(CrewStoreLive));
