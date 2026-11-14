// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2UserInputQuestion,
  RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import { CREW_APPROVAL } from "./crewPrompts.ts";

export class CrewApprovalError extends Schema.TaggedError<CrewApprovalError>()(
  "CrewApprovalError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const {
  approve: APPROVE,
  requestChanges: REQUEST_CHANGES,
  questionId: QUESTION_ID,
} = CREW_APPROVAL;

/** What the asking member reads once it has asked. */
const CREW_ASKED_NEXT =
  "Asked. End your turn now; the person's answer arrives as your next message.";

/**
 * A feature crew member asks the person in its own thread. The orchestrator commits the answer's
 * continuation with the answer itself, and the task stays open meanwhile (see `awaitsPerson`), so
 * the lead gets the outcome the member replies with, never the work or the question.
 */
export class CrewApprovals extends Context.Service<
  CrewApprovals,
  {
    /** Opens the question on `threadId`, a crew member's thread; one at a time. */
    readonly ask: (
      threadId: ThreadId,
      input: { readonly question: string; readonly options?: ReadonlyArray<string> | undefined },
    ) => Effect.Effect<
      { readonly requestId: RuntimeRequestId; readonly next: string },
      CrewApprovalError
    >;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Closes questions nobody can act on any more that no event reached, such as across a restart. */
    readonly catchUp: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/crew/CrewApprovals") {}

/** The question's header names who asks, which every client already shows. */
const crewQuestionHeader = (member: string | undefined, approval: boolean) =>
  `${member?.trim() || "A crew member"} is asking${approval ? " for your approval" : ""}`;

const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;

  const pendingQuestions = Effect.fnUntraced(function* (threadId: ThreadId) {
    const { runtimeRequests } = yield* projections.getThreadRecords(threadId, ["runtimeRequests"], {
      runtimeRequestStatuses: ["pending"],
    });
    return runtimeRequests.filter((request) => request.owner === "crew");
  });

  const unavailable = (cause: unknown) =>
    new CrewApprovalError({
      reason: `Unable to ask the person: ${cause instanceof Error ? cause.message : String(cause)}`,
    });

  const ask: CrewApprovals["Service"]["ask"] = Effect.fn("CrewApprovals.ask")(
    function* (threadId, input) {
      const thread = yield* projections.getThread(threadId).pipe(Effect.mapError(unavailable));
      if (thread.feature?.member === undefined || thread.lineage.parentThreadId === null) {
        return yield* new CrewApprovalError({
          reason: "Only a feature's crew member asks the person this way.",
        });
      }
      const question = input.question.trim();
      if (question.length === 0 || question.length > 4_000) {
        return yield* new CrewApprovalError({ reason: "Ask a short question." });
      }
      const [open] = yield* pendingQuestions(threadId).pipe(Effect.mapError(unavailable));
      if (open !== undefined) return { requestId: open.id, next: CREW_ASKED_NEXT };
      const approval = input.options === undefined || input.options.length === 0;
      const labels = [
        ...new Set(
          (approval ? [APPROVE, REQUEST_CHANGES] : (input.options ?? []))
            .map((label) => label.trim())
            .filter((label) => label.length > 0),
        ),
      ].slice(0, 6);
      const options: OrchestrationV2UserInputQuestion["options"] = (
        labels.length > 0 ? labels : [APPROVE, REQUEST_CHANGES]
      ).map((label) => ({
        label,
        description:
          label === APPROVE
            ? "Continue with this as it is."
            : label === REQUEST_CHANGES
              ? "Say what to change below."
              : label,
      }));
      const requestId = RuntimeRequestId.make(`crew-ask:${NodeCrypto.randomUUID()}`);
      yield* engine
        .dispatch({
          type: "user-input.open",
          commandId: CommandId.make(`server:crew-ask:${requestId}`),
          threadId,
          requestId,
          owner: "crew",
          questions: [
            {
              id: QUESTION_ID,
              header: crewQuestionHeader(thread.feature.member, approval),
              question,
              options,
              allowCustomAnswer: true,
            },
          ],
        })
        .pipe(Effect.mapError(unavailable));
      return { requestId, next: CREW_ASKED_NEXT };
    },
  );

  /**
   * Closes the member's question once nobody can act on its answer: its task settled, as on a
   * cancel, or its thread was archived or deleted. Closing it lets the task settle.
   */
  const dismissOrphaned = Effect.fnUntraced(function* (childThreadId: ThreadId) {
    const questions = yield* pendingQuestions(childThreadId);
    if (questions.length === 0 || (yield* engine.crewTaskAwaitsAnswer(childThreadId))) return;
    for (const request of questions) {
      yield* engine.dispatch({
        type: "thread.user-input.dismiss",
        commandId: CommandId.make(`server:crew-ask-dismiss:${request.id}`),
        threadId: childThreadId,
        requestId: request.id,
      });
    }
  });

  const handle: CrewApprovals["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "thread.archived" || event.type === "thread.deleted") {
        yield* dismissOrphaned(event.threadId);
        return;
      }
      if (event.type === "subagent.updated") {
        const task = event.payload;
        if (
          task.origin !== "app_owned" ||
          task.childThreadId === null ||
          !["completed", "failed", "cancelled", "interrupted"].includes(task.status)
        )
          return;
        yield* dismissOrphaned(task.childThreadId);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("handling a crew question failed", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const catchUp: CrewApprovals["Service"]["catchUp"] = Effect.fn("CrewApprovals.catchUp")(
    function* () {
      const rows = yield* sql<{ readonly threadId: ThreadId }>`
        SELECT DISTINCT thread_id AS threadId FROM orchestration_v2_projection_runtime_requests
        WHERE status = 'pending' AND json_extract(payload_json, '$.owner') = 'crew'
      `;
      for (const row of rows) {
        yield* dismissOrphaned(row.threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("catching up a crew question failed", {
              threadId: row.threadId,
              cause,
            }),
          ),
        );
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("catching up crew questions failed", { cause })),
  );

  // Start-up `catchUp` covers what committed before the stream subscribed.
  const start: CrewApprovals["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("crew question event stream failed", { cause }),
        ),
      ),
    );

  return CrewApprovals.of({ ask, handle, catchUp, start });
});

export const layer = Layer.effect(CrewApprovals, make);
