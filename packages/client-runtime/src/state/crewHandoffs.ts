import type { ThreadCrewHandoff, ThreadId } from "@t3tools/contracts";

/** What a crew thread waits on from the members it handed work to. */
export interface CrewHandoffWait {
  readonly kind: "waiting" | "question" | "failed";
  readonly title: string;
  readonly detail: string | null;
  /** The open handoffs Stop cancels, or the failed one Retry restarts. */
  readonly handoffIds: ReadonlyArray<string>;
  /** Set when every handoff went to one thread. */
  readonly threadId: ThreadId | null;
  /** Set for a single open handoff. */
  readonly startedAt: string | null;
}

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * The line for a thread's `crewHandoffs`. The server lists the open ones, or the latest if it
 * failed; a failure stops showing once the thread finishes a turn after it.
 */
export function presentCrewHandoffWait(
  handoffs: ReadonlyArray<ThreadCrewHandoff>,
  /** When the thread last finished a turn. */
  lastCompletedAt: string | null,
): CrewHandoffWait | null {
  const open = handoffs.filter((handoff) => handoff.status !== "failed");
  if (open.length === 0) {
    const failed = handoffs[0];
    if (!failed) return null;
    if (lastCompletedAt !== null && Date.parse(lastCompletedAt) > Date.parse(failed.updatedAt)) {
      return null;
    }
    return {
      kind: "failed",
      title: `${failed.member} failed`,
      detail: failed.error,
      handoffIds: [failed.id],
      threadId: failed.threadId,
      startedAt: null,
    };
  }

  const only = open.length === 1 ? open[0]! : null;
  const question = open.find((handoff) => handoff.status === "needs-input");
  const threads = new Set(open.map((handoff) => handoff.threadId));
  const [onlyThread] = threads.size === 1 ? threads : [];
  const base = {
    handoffIds: open.map((handoff) => handoff.id),
    threadId: onlyThread ?? null,
    startedAt: only?.createdAt ?? null,
  };
  if (only?.status === "needs-input") {
    return {
      ...base,
      kind: "question",
      title: `${only.member} asked a question`,
      detail: only.question,
    };
  }
  return {
    ...base,
    kind: "waiting",
    title: `Waiting on ${joinWithAnd(Array.from(new Set(open.map((handoff) => handoff.member))))}`,
    detail: question
      ? `${question.member} asked: ${question.question ?? "a question"}`
      : open[0]!.task || null,
  };
}
