import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BotHandoffService } from "../../../bots/BotHandoffService.ts";
import { BotHandoffStore } from "../../../bots/BotHandoffStore.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { BotToolFailedError, BotsToolkit } from "./tools.ts";

const isMcpCapabilityUnavailableError = Schema.is(McpCapabilityUnavailableError);

const make = Effect.gen(function* () {
  const handoffs = yield* BotHandoffService;
  const handoffStore = yield* BotHandoffStore;
  const botStore = yield* BotStore;

  const inScope = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    McpInvocationContext.requireMcpCapability("bots").pipe(
      Effect.flatMap(() => effect),
      Effect.mapError((error) =>
        isMcpCapabilityUnavailableError(error)
          ? error
          : new BotToolFailedError({ reason: String(error) }),
      ),
    );

  return {
    bots_delegate: (input: {
      readonly requestId: string;
      readonly targetBotId: string;
      readonly taskText: string;
      readonly contextText?: string | undefined;
    }) =>
      inScope(
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const runId = yield* handoffStore.getRunByThread(scope.threadId);
          const run = runId ? yield* botStore.getRun(runId) : null;
          if (!run)
            return yield* Effect.fail(
              new BotToolFailedError({ reason: "Caller is not a bot run" }),
            );
          return yield* handoffs.delegate({
            id: input.requestId,
            sourceThreadId: scope.threadId,
            targetBotId: input.targetBotId,
            projectId: run.projectId,
            taskText: input.taskText,
            ...(input.contextText !== undefined ? { contextText: input.contextText } : {}),
          });
        }),
      ),
    bots_respond: (input: { readonly outcome: "completed" | "failed"; readonly summary: string }) =>
      inScope(
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => handoffs.respond(scope.threadId, input.outcome, input.summary)),
        ),
      ),
    bots_ask: (input: { readonly question: string }) =>
      inScope(
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => handoffs.ask(scope.threadId, input.question)),
        ),
      ),
    bots_list_handoffs: () =>
      inScope(
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const runId = yield* handoffStore.getRunByThread(scope.threadId);
          const run = runId ? yield* botStore.getRun(runId) : null;
          if (!run?.allowedTools.includes("bots.status")) {
            return yield* Effect.fail(
              new BotToolFailedError({ reason: "Caller cannot inspect bot requests" }),
            );
          }
          return { handoffs: yield* handoffs.listByRun(run.id) };
        }),
      ),
    bots_wait_handoff: (input: { readonly requestId: string }) =>
      inScope(
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) => handoffs.waitFor(scope.threadId, input.requestId)),
        ),
      ),
    bots_answer: (input: { readonly requestId: string; readonly answer: string }) =>
      inScope(
        McpInvocationContext.McpInvocationContext.pipe(
          Effect.flatMap((scope) =>
            handoffs.answerFromBot(scope.threadId, input.requestId, input.answer),
          ),
        ),
      ),
  };
});

export const BotsToolkitHandlersLive = BotsToolkit.toLayer(make);
