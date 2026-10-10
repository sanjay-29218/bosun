import { McpCapabilityUnavailableError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { BotHandoffService } from "../../../bots/BotHandoffService.ts";
import { BotHandoffStore } from "../../../bots/BotHandoffStore.ts";
import { BotStore } from "../../../bots/BotStore.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotToolFailedError, BotsToolkit } from "./tools.ts";

const isAccessError = Schema.is(
  Schema.Union([McpCapabilityUnavailableError, OrchestratorMcpFailure]),
);

/** Bot tools act for the bot run behind the calling thread, so only thread callers have one. */
const requireBotThread = McpInvocationContext.requireMcpCapability("bots").pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This bot tool")),
  Effect.map((scope) => scope.thread.threadId),
);

const make = Effect.gen(function* () {
  const handoffs = yield* BotHandoffService;
  const handoffStore = yield* BotHandoffStore;
  const botStore = yield* BotStore;
  const workflows = yield* WorkflowService;

  const asBot = <A, E, R>(
    effect: (threadId: McpInvocationContext.McpThreadCaller["threadId"]) => Effect.Effect<A, E, R>,
  ) =>
    requireBotThread.pipe(
      Effect.flatMap(effect),
      Effect.mapError((error) =>
        isAccessError(error) ? error : new BotToolFailedError({ reason: String(error) }),
      ),
    );

  return {
    bots_delegate: McpToolAccess.actsAsCaller(
      (input: {
        readonly requestId: string;
        readonly targetBotId: string;
        readonly taskText: string;
        readonly contextText?: string | undefined;
      }) =>
        asBot((threadId) =>
          Effect.gen(function* () {
            const runId = yield* handoffStore.getRunByThread(threadId);
            const run = runId ? yield* botStore.getRun(runId) : null;
            if (!run)
              return yield* Effect.fail(
                new BotToolFailedError({ reason: "Caller is not a bot run" }),
              );
            return yield* handoffs.delegate({
              id: input.requestId,
              sourceThreadId: threadId,
              targetBotId: input.targetBotId,
              projectId: run.projectId,
              taskText: input.taskText,
              ...(input.contextText !== undefined ? { contextText: input.contextText } : {}),
            });
          }),
        ),
    ),
    bots_respond: McpToolAccess.actsAsCaller(
      (input: { readonly outcome: "completed" | "failed"; readonly summary: string }) =>
        asBot((threadId) => handoffs.respond(threadId, input.outcome, input.summary)),
    ),
    bots_ask: McpToolAccess.actsAsCaller((input: { readonly question: string }) =>
      asBot((threadId) => handoffs.ask(threadId, input.question)),
    ),
    bots_list_handoffs: McpToolAccess.readsAsCaller(() =>
      asBot((threadId) =>
        Effect.gen(function* () {
          const runId = yield* handoffStore.getRunByThread(threadId);
          const run = runId ? yield* botStore.getRun(runId) : null;
          if (!run?.allowedTools.includes("bots.status")) {
            return yield* Effect.fail(
              new BotToolFailedError({ reason: "Caller cannot inspect bot requests" }),
            );
          }
          return { handoffs: yield* handoffs.listByRun(run.id) };
        }),
      ),
    ),
    bots_wait_handoff: McpToolAccess.readsAsCaller((input: { readonly requestId: string }) =>
      asBot((threadId) => handoffs.waitFor(threadId, input.requestId)),
    ),
    bots_stage_handoff: McpToolAccess.readsAsCaller(() =>
      asBot((threadId) =>
        Effect.gen(function* () {
          const runId = yield* handoffStore.getRunByThread(threadId);
          const run = runId ? yield* botStore.getRun(runId) : null;
          if (!run?.allowedTools.includes("bots.respond")) {
            return yield* Effect.fail(
              new BotToolFailedError({ reason: "Caller is not a workflow stage bot" }),
            );
          }
          const record = yield* workflows.getStageHandoffForThread(run.projectId, threadId);
          if (!record) {
            return yield* Effect.fail(
              new BotToolFailedError({ reason: "This run did not start from a workflow stage" }),
            );
          }
          return record;
        }),
      ),
    ),
    bots_answer: McpToolAccess.actsAsCaller(
      (input: { readonly requestId: string; readonly answer: string }) =>
        asBot((threadId) => handoffs.answerFromBot(threadId, input.requestId, input.answer)),
    ),
  };
});

export const layer = McpToolAccess.toLayer(BotsToolkit, make);
