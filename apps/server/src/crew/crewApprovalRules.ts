import * as DateTime from "effect/DateTime";
import {
  type CommandId,
  isOrchestrationV2WorkActive,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2UserInputQuestion,
  type ProviderUserInputAnswers,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";

import { CREW_APPROVAL, crewQuestionReply } from "./crewPrompts.ts";

/**
 * The rules the orchestrator follows for a crew member's question to the person, kept here so
 * its upstream code only calls them. Pure: callers read the records and emit the results.
 */

type Request = Pick<OrchestrationV2RuntimeRequest, "status" | "owner">;

/** The message that resumes the member after its question `requestId` closes. */
const crewAnswerMessageId = (requestId: string) =>
  MessageId.make(`message:crew-answer:${requestId}`);

/** A crew member asked the person and ended its turn: its task has no result until they answer. */
export const crewQuestionHoldsTask = (requests: ReadonlyArray<Request>) =>
  requests.some((request) => request.status === "pending" && request.owner === "crew");

/** A crew question that closed no longer holds its task, so settlement runs again. */
export const crewQuestionClosed = (request: Request) =>
  request.owner === "crew" && request.status !== "pending";

/**
 * Whether the person's answer can still continue the member's work: its thread is live and its
 * lead still waits on a task it runs, not settled or cancelled.
 */
export const crewTaskAwaitsAnswer = (
  child: Pick<OrchestrationV2ThreadProjection["thread"], "id" | "archivedAt" | "deletedAt">,
  parentTasks: ReadonlyArray<OrchestrationV2Subagent>,
) =>
  child.archivedAt === null &&
  child.deletedAt === null &&
  parentTasks.some(
    (task) =>
      task.origin === "app_owned" &&
      task.childThreadId === child.id &&
      task.result === null &&
      task.cancelledRunId === undefined &&
      isOrchestrationV2WorkActive(task.status),
  );

/**
 * The message that resumes the member once the person answers (`answers`) or dismisses its
 * question (`answers` undefined), or null when no open task waits on it. The orchestrator
 * dispatches it in the command that resolves the question, under that command's locks, so a
 * restart or a cancel never falls between the answer and the work it resumes.
 */
export const crewAnswerContinuation = (input: {
  readonly commandId: CommandId;
  readonly requestId: RuntimeRequestId;
  readonly child: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "id" | "archivedAt" | "deletedAt"
  >;
  readonly parentTasks: ReadonlyArray<OrchestrationV2Subagent>;
  readonly answers: ProviderUserInputAnswers | undefined;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> | null => {
  if (!crewTaskAwaitsAnswer(input.child, input.parentTasks)) return null;
  const raw = input.answers?.[CREW_APPROVAL.questionId];
  const reply = crewQuestionReply(
    input.answers === undefined
      ? null
      : (Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "").trim(),
    input.questions.flatMap((question) => question.options.map((option) => option.label)),
  );
  return {
    type: "message.dispatch",
    commandId: input.commandId,
    threadId: input.child.id as ThreadId,
    messageId: crewAnswerMessageId(input.requestId),
    text: reply.text,
    // A wake continues the member's open follow-up task, as it continues the original.
    notification: { source: { kind: "system" }, outcome: "updated", summary: reply.summary },
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
  };
};

/**
 * The lead's result when the member's last question closed unanswered with nothing after it, as
 * when its thread was archived: one line, never the member's last message, which can be the
 * whole design it asked about. Null otherwise.
 */
export const crewUnansweredResult = (input: {
  readonly thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "title" | "archivedAt" | "deletedAt" | "feature"
  >;
  readonly requests: ReadonlyArray<
    Pick<OrchestrationV2RuntimeRequest, "id" | "owner" | "status" | "answers" | "createdAt">
  >;
  readonly resultRun: Pick<OrchestrationV2Run, "requestedAt" | "userMessageId">;
}): string | null => {
  const last = input.requests
    .filter((request) => request.owner === "crew")
    .toSorted(
      (a, b) => DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
    )[0];
  if (
    last === undefined ||
    last.status === "pending" ||
    last.answers !== undefined ||
    input.resultRun.userMessageId === crewAnswerMessageId(last.id) ||
    DateTime.isGreaterThan(input.resultRun.requestedAt, last.createdAt)
  )
    return null;
  const member = input.thread.feature?.member ?? input.thread.title;
  const why =
    input.thread.deletedAt !== null
      ? "its thread was deleted"
      : input.thread.archivedAt !== null
        ? "its thread was archived"
        : "it was closed";
  return `${member}'s question went unanswered: ${why}.`;
};
