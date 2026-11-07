import { headquartersProjectId, isStandingThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as TurnBriefing from "../orchestration-v2/TurnBriefing.ts";
import { crewRunPrompt } from "./crewPrompts.ts";
import { managerInstructions, projectManagerMemberId } from "./CrewService.ts";
import { CrewStore, CrewStoreLive } from "./CrewStore.ts";

/**
 * A bot's headquarters is briefed with its run's instructions and task; a project's manager with
 * its current instructions.
 */
export const StandingBriefingLive = Layer.effect(
  TurnBriefing.TurnBriefing,
  Effect.gen(function* () {
    const store = yield* CrewStore;
    return TurnBriefing.TurnBriefing.of({
      forThread: Effect.fn("StandingBriefing.forThread")(function* (threadId) {
        if (!isStandingThread(threadId)) return null;
        const projectId = headquartersProjectId(threadId);
        return yield* Effect.gen(function* () {
          const run = yield* store.getRunByThread(threadId);
          if (run === null) return null;
          // A manager's run keeps the text it was made with; brief it with its current text.
          const member =
            projectId === null ? null : yield* store.getMember(projectManagerMemberId(projectId));
          return crewRunPrompt(
            member === null || projectId === null
              ? run
              : { ...run, instructions: managerInstructions(member, projectId) },
          );
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Standing thread briefing unavailable", { threadId, error }).pipe(
              Effect.as(null),
            ),
          ),
        );
      }),
    });
  }),
).pipe(Layer.provide(CrewStoreLive));
