import {
  type EnvironmentId,
  headquartersBotId,
  headquartersProjectId,
  OrchestratorMcpFailure,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as BotStore from "./BotStore.ts";

/** Why a bot can't start work on a linked environment it isn't permitted on. */
export const notPermitted = (botName: string, label: string) =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message: `${botName} isn't allowed to start work on ${label}. Nothing was started there. The person can allow it in Bots → ${botName} → Projects → Can work on.`,
  });

const unavailable = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message });

/**
 * Keeps a bot's work on the linked environments it is permitted on. A thread is the bot's work
 * when it is the bot's headquarters, or its project (or project manager's project) belongs to
 * the bot. Threads with no bot pass.
 */
export class BotEnvironmentGuard extends Context.Service<
  BotEnvironmentGuard,
  {
    readonly check: (
      threadId: ThreadId,
      target: EnvironmentId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("t3/bots/BotEnvironmentGuard") {}

const make = Effect.gen(function* () {
  const store = yield* BotStore.BotStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const links = yield* PeerLinks.PeerLinks;

  const botOf = Effect.fn("BotEnvironmentGuard.botOf")(function* (threadId: ThreadId) {
    const headquarters = headquartersBotId(threadId);
    if (headquarters !== null) return headquarters;
    const projectId =
      headquartersProjectId(threadId) ??
      (yield* threads.getThreadShell(threadId))?.projectId ??
      null;
    return projectId === null ? null : yield* store.projectOwner(projectId);
  }, Effect.mapError(unavailable));

  return BotEnvironmentGuard.of({
    check: Effect.fn("BotEnvironmentGuard.check")(function* (threadId, target) {
      const botId = yield* botOf(threadId);
      if (botId === null) return;
      const bot = yield* store.get(botId).pipe(Effect.mapError(unavailable));
      if (bot === null || bot.permittedEnvironmentIds.includes(target)) return;
      const link = yield* links.get(target).pipe(Effect.orElseSucceed(() => Option.none()));
      return yield* notPermitted(
        bot.name,
        Option.match(link, { onNone: () => target, onSome: (found) => found.label }),
      );
    }),
  });
});

export const layer = Layer.effect(BotEnvironmentGuard, make);
