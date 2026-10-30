import type { ThreadCrewHandoff, ThreadId } from "@t3tools/contracts";

type CrewHandoffWaitKind = "waiting" | "question" | "failed";

/** What a crew thread waits on from the members it handed work to. */
export interface CrewHandoffWait {
  readonly kind: CrewHandoffWaitKind;
  readonly title: string;
  readonly detail: string | null;
  /** The members it waits on, or the one that asked or failed. */
  readonly members: ReadonlyArray<string>;
  /** The open handoffs Stop cancels, or the failed one Retry restarts. */
  readonly handoffIds: ReadonlyArray<string>;
  /** Set when every handoff went to one thread. */
  readonly threadId: ThreadId | null;
  /** Set for a single open handoff. */
  readonly startedAt: string | null;
  /**
   * Set when the one member this thread waits on is itself held up further down: who holds it
   * up, and how. `detail` then describes that instead of the task.
   */
  readonly blockedBy: {
    readonly kind: CrewHandoffWaitKind;
    readonly member: string;
    readonly threadId: ThreadId | null;
  } | null;
}

/** A thread's handoffs and when it last finished a turn; a failure older than that is old news. */
export interface CrewHandoffThread {
  readonly crewHandoffs: ReadonlyArray<ThreadCrewHandoff>;
  readonly lastCompletedAt: string | null;
}

const MAX_CHAIN = 8;

function joinWithAnd(parts: ReadonlyArray<string>): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

function openHandoffs(handoffs: ReadonlyArray<ThreadCrewHandoff>) {
  return handoffs.filter((handoff) => handoff.status !== "failed");
}

function ownWait(thread: CrewHandoffThread): CrewHandoffWait | null {
  const open = openHandoffs(thread.crewHandoffs);
  if (open.length === 0) {
    const failed = thread.crewHandoffs[0];
    if (!failed) return null;
    if (
      thread.lastCompletedAt !== null &&
      Date.parse(thread.lastCompletedAt) > Date.parse(failed.updatedAt)
    ) {
      return null;
    }
    return {
      kind: "failed",
      title: `${failed.member} failed`,
      detail: failed.error,
      members: [failed.member],
      handoffIds: [failed.id],
      threadId: failed.threadId,
      startedAt: null,
      blockedBy: null,
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
    blockedBy: null,
  };
  if (only?.status === "needs-input") {
    return {
      ...base,
      kind: "question",
      title: `${only.member} asked a question`,
      detail: only.question,
      members: [only.member],
    };
  }
  const members = Array.from(new Set(open.map((handoff) => handoff.member)));
  return {
    ...base,
    kind: "waiting",
    title: `Waiting on ${joinWithAnd(members)}`,
    members,
    detail: question
      ? `${question.member} asked: ${question.question ?? "a question"}`
      : open[0]!.task || null,
  };
}

/**
 * The line for a thread's `crewHandoffs`. While it waits on one member, follows that member's
 * own handoffs down the chain and names what holds the work up at the end of it.
 */
export function presentCrewHandoffWait(
  thread: CrewHandoffThread,
  readThread: (threadId: ThreadId) => CrewHandoffThread | null = () => null,
): CrewHandoffWait | null {
  const own = ownWait(thread);
  if (own?.kind !== "waiting" || own.handoffIds.length !== 1 || own.threadId === null) return own;
  let member = own.members[0]!;
  let threadId: ThreadId = own.threadId;
  let blocked: { readonly holder: string; readonly wait: CrewHandoffWait } | null = null;
  const seen = new Set<ThreadId>();
  while (!seen.has(threadId) && seen.size < MAX_CHAIN) {
    seen.add(threadId);
    const next = readThread(threadId);
    const wait = next ? ownWait(next) : null;
    if (!next || !wait) break;
    blocked = { holder: member, wait };
    if (wait.kind !== "waiting" || wait.handoffIds.length !== 1 || wait.threadId === null) break;
    member = wait.members[0]!;
    threadId = wait.threadId;
  }
  if (blocked === null) return own;
  const { holder, wait } = blocked;
  const blockedMember = joinWithAnd(wait.members);
  return {
    ...own,
    detail:
      wait.kind === "waiting"
        ? `${holder} is waiting on ${blockedMember}`
        : wait.kind === "question"
          ? `${blockedMember} asked ${holder} a question`
          : `${blockedMember} failed`,
    blockedBy: { kind: wait.kind, member: blockedMember, threadId: wait.threadId },
  };
}

/**
 * Who a crew thread waits on, for its list row: "Builder", "Builder +1", or "Designer asked".
 * Null when nothing is out. Failures show in the thread, not the row.
 */
export function crewHandoffRowLabel(
  handoffs: ReadonlyArray<ThreadCrewHandoff> | undefined,
): string | null {
  const open = openHandoffs(handoffs ?? []);
  const first = open[0];
  if (!first) return null;
  if (open.length === 1 && first.status === "needs-input") return `${first.member} asked`;
  const members = Array.from(new Set(open.map((handoff) => handoff.member)));
  return members.length === 1 ? members[0]! : `${members[0]} +${members.length - 1}`;
}
