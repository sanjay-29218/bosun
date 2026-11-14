// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
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

export class CrewApprovalError extends Schema.TaggedError<CrewApprovalError>()(
  "CrewApprovalError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const APPROVE = "Approve";
const REQUEST_CHANGES = "Request changes";
const QUESTION_ID = "approval";

/** What the asking member reads once it has asked. */
export const CREW_ASKED_NEXT =
  "Asked. End your turn now; the person's answer arrives as your next message.";

/**
 * A feature crew member asks the person in its own thread, and their answer resumes it there.
 * Its delegated task stays open meanwhile (see `awaitsPerson`), so the lead gets the outcome the
 * member replies with, never the work or the question.
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
    /** Forwards answers and settles questions that no event reached, such as across a restart. */
    readonly catchUp: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/crew/CrewApprovals") {}

const answerText = (request: OrchestrationV2RuntimeRequest, options: ReadonlyArray<string>) => {
  const raw = request.answers?.[QUESTION_ID];
  const text = (Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "").trim();
  if (text === APPROVE) return { summary: "The person approved", said: "The person approved." };
  if (text === REQUEST_CHANGES)
    return {
      summary: "The person asked for changes",
      said: "The person asked for changes without saying which. Ask them what to change with crew_ask_person.",
    };
  if (options.includes(text))
    return { summary: "The person answered", said: `The person chose "${text}".` };
  const defaults = options.includes(APPROVE) && options.includes(REQUEST_CHANGES);
  return defaults
    ? { summary: "The person asked for changes", said: `The person asked for changes: ${text}` }
    : { summary: "The person answered", said: `The person answered: ${text}` };
};

const OUTCOME_HINT =
  'If that approves the work, reply with a one-line outcome, such as "Design approved: design.html", and end your turn. Otherwise revise the work here and ask again with crew_ask_person.';

const make = Effect.gen(function* () {
  const engine = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;

  /** Whether the lead still waits on a task this crew thread works on. */
  const hasOpenTask = Effect.fnUntraced(function* (childThreadId: ThreadId) {
    const child = yield* projections.getThread(childThreadId);
    const parentThreadId = child.lineage.parentThreadId;
    if (parentThreadId === null || child.lineage.relationshipToParent !== "subagent") return false;
    const { subagents } = yield* projections.getThreadRecords(parentThreadId, ["subagents"]);
    return subagents.some(
      (task) =>
        task.origin === "app_owned" &&
        task.childThreadId === childThreadId &&
        task.result === null &&
        task.cancelledRunId === undefined &&
        !["completed", "failed", "cancelled", "interrupted"].includes(task.status),
    );
  });

  const pendingQuestions = Effect.fnUntraced(function* (threadId: ThreadId) {
    const { runtimeRequests } = yield* projections.getThreadRecords(
      threadId,
      ["runtimeRequests"],
      { runtimeRequestStatuses: ["pending"] },
    );
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
      const labels = [
        ...new Set(
          (input.options ?? [APPROVE, REQUEST_CHANGES])
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
            ? "Approve the work shown in this thread."
            : label === REQUEST_CHANGES
              ? "Type what to change instead, or pick this to be asked."
              : label,
      }));
      const requestId = RuntimeRequestId.make(`crew-ask:${NodeCrypto.randomUUID()}`);
      yield* engine.dispatch({
        type: "user-input.open",
        commandId: CommandId.make(`server:crew-ask:${requestId}`),
        threadId,
        requestId,
        owner: "crew",
        questions: [
          {
            id: QUESTION_ID,
            header: "Approval",
            question,
            options,
            allowCustomAnswer: true,
          },
        ],
      }).pipe(Effect.mapError(unavailable));
      return { requestId, next: CREW_ASKED_NEXT };
    },
  );

  /** Sends the person's answer to the member that asked, which continues its delegated task. */
  const forward = Effect.fnUntraced(function* (
    threadId: ThreadId,
    request: OrchestrationV2RuntimeRequest,
  ) {
    // Dismissing resolves it with a cancel and no answers.
    const answered =
      request.status === "resolved" &&
      request.answers !== undefined &&
      request.decision !== "cancel" &&
      request.decision !== "decline";
    // Dismissed after its task settled, as on a cancel, there is no one left to tell.
    if (!answered && !(yield* hasOpenTask(threadId))) return;
    const options =
      answered
        ? (yield* projections.getThreadRecords(threadId, ["turnItems"], {
            turnItemTypes: ["user_input_request"],
          })).turnItems.flatMap((item) =>
            item.type === "user_input_request" && item.requestId === request.id
              ? item.questions.flatMap((question) => question.options.map((option) => option.label))
              : [],
          )
        : [];
    const reply = answered
      ? answerText(request, options)
      : {
          summary: "The person dismissed the question",
          said: "The person dismissed your question without answering. Reply with a one-line outcome saying it wasn't approved, and end your turn.",
        };
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:crew-answer:${request.id}`),
      threadId,
      messageId: MessageId.make(`message:crew-answer:${request.id}`),
      text: answered ? `${reply.said}\n\n${OUTCOME_HINT}` : reply.said,
      notification: { source: { kind: "system" }, outcome: "updated", summary: reply.summary },
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
    });
  });

  /** A task that settled while its member waited on the person leaves nothing to answer. */
  const dismissOrphaned = Effect.fnUntraced(function* (childThreadId: ThreadId) {
    const questions = yield* pendingQuestions(childThreadId);
    if (questions.length === 0 || (yield* hasOpenTask(childThreadId))) return;
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
      if (event.type === "runtime-request.updated") {
        if (event.payload.owner !== "crew" || event.payload.status === "pending") return;
        const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
        if (request === undefined || request.status === "pending") return;
        yield* forward(event.threadId, request);
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
      const rows = yield* sql<{ readonly threadId: ThreadId; readonly requestId: string }>`
        SELECT r.thread_id AS threadId, r.runtime_request_id AS requestId
        FROM orchestration_v2_projection_runtime_requests AS r
        WHERE json_extract(r.payload_json, '$.owner') = 'crew'
          AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages AS m
            WHERE m.message_id = 'message:crew-answer:' || r.runtime_request_id)
      `;
      for (const row of rows) {
        yield* Effect.gen(function* () {
          const request = yield* projections.getRuntimeRequest(
            row.threadId,
            RuntimeRequestId.make(row.requestId),
          );
          if (request === undefined) return;
          if (request.status === "pending") yield* dismissOrphaned(row.threadId);
          else yield* forward(row.threadId, request);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("catching up a crew question failed", {
              requestId: row.requestId,
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
