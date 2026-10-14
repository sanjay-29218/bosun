import { McpCapabilityUnavailableError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CrewHandoffService } from "../../../crew/CrewHandoffService.ts";
import { CrewHandoffStore } from "../../../crew/CrewHandoffStore.ts";
import { CrewStore } from "../../../crew/CrewStore.ts";
import { WorkflowService } from "../../../workflows/WorkflowService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { CrewToolFailedError, CrewToolkit } from "./tools.ts";

const isAccessError = Schema.is(
  Schema.Union([McpCapabilityUnavailableError, OrchestratorMcpFailure]),
);

/** Crew tools act for the crew run behind the calling thread, so only thread callers have one. */
const requireCrewThread = McpInvocationContext.requireMcpCapability("crew").pipe(
  Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "This crew tool")),
  Effect.map((scope) => scope.thread.threadId),
);

const make = Effect.gen(function* () {
  const handoffs = yield* CrewHandoffService;
  const handoffStore = yield* CrewHandoffStore;
  const crewStore = yield* CrewStore;
  const workflows = yield* WorkflowService;

  const asCrewMember = <A, E, R>(
    effect: (threadId: McpInvocationContext.McpThreadCaller["threadId"]) => Effect.Effect<A, E, R>,
  ) =>
    requireCrewThread.pipe(
      Effect.flatMap(effect),
      Effect.mapError((error) =>
        isAccessError(error) ? error : new CrewToolFailedError({ reason: String(error) }),
      ),
    );

  return {
    crew_delegate: McpToolAccess.actsAsCaller(
      (input: {
        readonly requestId: string;
        readonly targetMemberId: string;
        readonly taskText: string;
        readonly contextText?: string | undefined;
      }) =>
        asCrewMember((threadId) =>
          handoffs.delegate({
            id: input.requestId,
            sourceThreadId: threadId,
            targetMemberId: input.targetMemberId,
            taskText: input.taskText,
            ...(input.contextText !== undefined ? { contextText: input.contextText } : {}),
          }),
        ),
    ),
    crew_respond: McpToolAccess.actsAsCaller(
      (input: { readonly outcome: "completed" | "failed"; readonly summary: string }) =>
        asCrewMember((threadId) => handoffs.respond(threadId, input.outcome, input.summary)),
    ),
    crew_ask: McpToolAccess.actsAsCaller((input: { readonly question: string }) =>
      asCrewMember((threadId) => handoffs.ask(threadId, input.question)),
    ),
    crew_list_handoffs: McpToolAccess.readsAsCaller(() =>
      asCrewMember((threadId) =>
        handoffs.listForThread(threadId).pipe(Effect.map((list) => ({ handoffs: list }))),
      ),
    ),
    crew_wait_handoff: McpToolAccess.readsAsCaller((input: { readonly requestId: string }) =>
      asCrewMember((threadId) => handoffs.waitFor(threadId, input.requestId)),
    ),
    crew_stage_handoff: McpToolAccess.readsAsCaller(() =>
      asCrewMember((threadId) =>
        Effect.gen(function* () {
          const runId = yield* handoffStore.getRunByThread(threadId);
          const run = runId ? yield* crewStore.getRun(runId) : null;
          if (!run?.allowedTools.includes("crew.respond")) {
            return yield* Effect.fail(
              new CrewToolFailedError({ reason: "Caller is not a workflow stage member" }),
            );
          }
          const record = yield* workflows.getStageHandoffForThread(run.projectId, threadId);
          if (!record) {
            return yield* Effect.fail(
              new CrewToolFailedError({ reason: "This run did not start from a workflow stage" }),
            );
          }
          return record;
        }),
      ),
    ),
    crew_answer: McpToolAccess.actsAsCaller(
      (input: { readonly requestId: string; readonly answer: string }) =>
        asCrewMember((threadId) => handoffs.answerFromBot(threadId, input.requestId, input.answer)),
    ),
  };
});

export const layer = McpToolAccess.toLayer(CrewToolkit, make);
