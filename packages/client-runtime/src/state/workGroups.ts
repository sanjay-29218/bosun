import type { CrewStageSummary, ThreadCrewRequestTag } from "@t3tools/contracts";

import { formatStageName, isHiddenStageThread } from "../crewStage.ts";
import { threadNeedsYouKind, type NeedsYouShell } from "./crewBoard.ts";
import { inboxReturnAt, type InboxThreadInput } from "./threadInbox.ts";

/**
 * Thread lists show a feature, or a bot request's handoff chain, as one row: the group's
 * primary thread, titled by the work, with its other threads behind it. Shared by web and mobile.
 */
export interface WorkGroupThread {
  readonly id: string;
  readonly environmentId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly feature?: { readonly id: string; readonly title: string } | null;
  readonly crew?: Pick<CrewStageSummary, "stepId" | "index" | "total" | "state" | "current"> | null;
  readonly crewRequest?: ThreadCrewRequestTag | null;
}

/** A stage's place on the strip. Stages after the current one read as pending, even after a loop. */
export type WorkStageStatus = "done" | "working" | "needs-you" | "failed" | "paused" | "pending";

export interface WorkGroupEntry<T> {
  readonly thread: T;
  /** "Design", "Design · try 2", "Builder", or the thread's title outside a stage. */
  readonly label: string;
}

export interface WorkGroup<T> {
  readonly key: string;
  readonly kind: "feature" | "request";
  readonly title: string;
  readonly primary: T;
  /** The group's other threads: stages in workflow order, then the rest oldest first. */
  readonly children: ReadonlyArray<WorkGroupEntry<T>>;
  /** One status per workflow stage; empty for a request or a one-stage workflow. */
  readonly stages: ReadonlyArray<WorkStageStatus>;
  /** The current stage, as "Build · 3/5"; null for a request or a one-stage workflow. */
  readonly stageLine: string | null;
}

/** The key a thread groups under, or null for a thread outside any work. */
function workGroupKey(thread: WorkGroupThread): string | null {
  if (thread.feature) return `${thread.environmentId}:feature:${thread.feature.id}`;
  if (thread.crewRequest) return `${thread.environmentId}:request:${thread.crewRequest.id}`;
  return null;
}

/** A thread named by the work it is on: "Clip crop editing · Build", "Triage issues · Builder". */
export function workThreadLabel(
  thread: Pick<WorkGroupThread, "title" | "feature" | "crew" | "crewRequest">,
): string {
  if (thread.feature) {
    return thread.crew
      ? `${thread.feature.title} · ${formatStageName(thread.crew.stepId)}`
      : thread.feature.title;
  }
  if (thread.crewRequest) return `${thread.crewRequest.title} · ${thread.crewRequest.member}`;
  return thread.title;
}

const threadKey = (thread: WorkGroupThread) => `${thread.environmentId}:${thread.id}`;

function stageStatus(state: CrewStageSummary["state"]): WorkStageStatus {
  switch (state) {
    case "working":
    case "queued":
      return "working";
    case "approval":
    case "input":
    case "your-call":
      return "needs-you";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "done":
    case "cancelled":
      return "done";
  }
}

const byCreated = (left: WorkGroupThread, right: WorkGroupThread) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

/** Labels threads by stage or crew member, numbering repeat attempts. */
function labelEntries<T extends WorkGroupThread>(threads: ReadonlyArray<T>) {
  const seen = new Map<string, number>();
  return threads.map((thread) => {
    const base = thread.crew
      ? formatStageName(thread.crew.stepId)
      : (thread.crewRequest?.member ?? thread.title);
    const attempt = (seen.get(base) ?? 0) + 1;
    seen.set(base, attempt);
    return { thread, label: attempt === 1 ? base : `${base} · try ${attempt}` };
  });
}

function buildGroup<T extends WorkGroupThread>(
  key: string,
  primary: T,
  members: ReadonlyArray<T>,
): WorkGroup<T> {
  const others = members.filter((thread) => thread !== primary);
  if (primary.feature) {
    const stageThreads = members
      .filter((thread) => thread.crew)
      .sort((left, right) => left.crew!.index - right.crew!.index || byCreated(left, right));
    const labelled = labelEntries(stageThreads);
    const current = members.find((thread) => thread.crew?.current)?.crew ?? null;
    // A one-stage workflow, such as Quick task, has no progress to show.
    const total = current?.total ?? stageThreads.at(-1)?.crew?.total ?? 0;
    const staged = total > 1;
    return {
      key,
      kind: "feature",
      title: primary.feature.title,
      primary,
      children: [
        ...labelled.filter((entry) => entry.thread !== primary),
        ...labelEntries(others.filter((thread) => !thread.crew).sort(byCreated)),
      ],
      stages: Array.from({ length: staged ? total : 0 }, (_, position) => {
        const index = position + 1;
        if (current === null) return "pending";
        if (index < current.index) return "done";
        return index === current.index ? stageStatus(current.state) : "pending";
      }),
      stageLine:
        current && staged
          ? `${formatStageName(current.stepId)} · ${current.index}/${current.total}`
          : null,
    };
  }
  return {
    key,
    kind: "request",
    title: primary.crewRequest?.title || primary.title,
    primary,
    children: labelEntries([...members].sort(byCreated)).filter(
      (entry) => entry.thread !== primary,
    ),
    stages: [],
    stageLine: null,
  };
}

/**
 * Folds tagged threads into one row per feature or bot request. `visible` are the threads the
 * list may show; `history` are threads that only appear inside a group, such as a feature's
 * earlier stages. A feature's row is its current stage thread, else its latest thread; a
 * request's row is the latest attempt of the thread the chain started with.
 */
export function groupWorkThreads<T extends WorkGroupThread>(
  visible: ReadonlyArray<T>,
  history: ReadonlyArray<T> = [],
): { readonly primaries: T[]; readonly groupByThreadKey: Map<string, WorkGroup<T>> } {
  const membersByKey = new Map<string, T[]>();
  const visibleKeys = new Set<string>();
  for (const thread of visible) {
    const key = workGroupKey(thread);
    if (key === null) continue;
    visibleKeys.add(key);
    membersByKey.set(key, [...(membersByKey.get(key) ?? []), thread]);
  }
  for (const thread of history) {
    const key = workGroupKey(thread);
    if (key !== null && visibleKeys.has(key)) membersByKey.get(key)!.push(thread);
  }
  const shown = new Set(visible);
  const groupByThreadKey = new Map<string, WorkGroup<T>>();
  const folded = new Set<T>();
  for (const [key, members] of membersByKey) {
    const candidates = members.filter((thread) => shown.has(thread));
    let primary: T;
    if (candidates[0]!.feature) {
      primary =
        candidates.find((thread) => thread.crew?.current) ??
        [...candidates].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]!;
    } else {
      const rootMember = [...members].sort(byCreated)[0]!.crewRequest?.member;
      const roots = candidates.filter((thread) => thread.crewRequest?.member === rootMember);
      primary = (roots.length > 0 ? roots : [...candidates]).sort(byCreated).at(-1)!;
    }
    for (const member of members) if (member !== primary) folded.add(member);
    groupByThreadKey.set(threadKey(primary), buildGroup(key, primary, members));
  }
  return {
    primaries: visible.filter((thread) => !folded.has(thread)),
    groupByThreadKey,
  };
}

/**
 * Each feature's row in the thread list, by `environmentId:featureId`, built from the threads
 * the list shows for it (its lead and current stage). The feature is settled when the row's
 * primary is, as the list files it.
 */
export function featureRows<T extends WorkGroupThread & { readonly archivedAt: unknown }>(
  threads: ReadonlyArray<T>,
): ReadonlyMap<string, WorkGroup<T>> {
  const featureThreads = threads.filter((thread) => thread.feature && thread.archivedAt === null);
  const { groupByThreadKey } = groupWorkThreads(
    featureThreads.filter((thread) => !isHiddenStageThread(thread)),
  );
  const rows = new Map<string, WorkGroup<T>>();
  for (const group of groupByThreadKey.values()) {
    rows.set(`${group.primary.environmentId}:${group.primary.feature!.id}`, group);
  }
  return rows;
}

/** A group's threads, its primary first. */
export const workGroupThreads = <T>(group: WorkGroup<T>) => [
  group.primary,
  ...group.children.map((entry) => entry.thread),
];

/**
 * Who a group answers to: a bot request's first role, or a feature's lead (its project
 * manager), the first of its threads that is neither a stage nor a helper a stage asked.
 * Null for a feature a bot's headquarters runs, which has no lead thread.
 */
export function workGroupLead<T extends WorkGroupThread>(group: WorkGroup<T>): T | null {
  if (group.kind === "request") return group.primary;
  return (
    workGroupThreads(group)
      .filter((thread) => !thread.crew && !thread.crewRequest)
      .sort(byCreated)[0] ?? null
  );
}

/** The thread a group's row opens: the one waiting on you, else the lead, else the row's own. */
export function workGroupOpenThread<T extends WorkGroupThread & NeedsYouShell>(
  group: WorkGroup<T>,
): T {
  return (
    workGroupThreads(group).find((thread) => threadNeedsYouKind(thread) !== null) ??
    workGroupLead(group) ??
    group.primary
  );
}

/** The group `thread` belongs to, built from `threads`, its environment's unarchived threads. */
export function workGroupOf<T extends WorkGroupThread>(
  thread: T,
  threads: ReadonlyArray<T>,
): WorkGroup<T> | null {
  const key = workGroupKey(thread);
  if (key === null) return null;
  const members = threads.filter((candidate) => workGroupKey(candidate) === key);
  return (
    groupWorkThreads(members.length > 0 ? members : [thread])
      .groupByThreadKey.values()
      .next().value ?? null
  );
}

/** The one thread of a feature or request that shows under its row: the first waiting on you. */
export function waitingWorkGroupEntry<T extends WorkGroupThread & NeedsYouShell>(
  group: WorkGroup<T>,
) {
  return group.children.find((entry) => threadNeedsYouKind(entry.thread) !== null);
}

/**
 * The row to mark while one of a feature's or request's threads is open. The waiting thread
 * shown under the row marks itself instead.
 */
export function resolveWorkGroupRouteRowKey<T extends WorkGroupThread & NeedsYouShell>(
  workGroups: ReadonlyMap<string, WorkGroup<T>>,
  routeThreadKey: string | null,
): string | null {
  if (routeThreadKey === null) return null;
  for (const [rowKey, group] of workGroups) {
    const waiting = waitingWorkGroupEntry(group)?.thread;
    const open = group.children.find(
      (entry) => `${entry.thread.environmentId}:${entry.thread.id}` === routeThreadKey,
    );
    if (open && open.thread !== waiting) return rowKey;
  }
  return null;
}

/** Past any real timestamp, so rows waiting on you sort ahead of the rest. */
const WAITING_ON_YOU_LIFT = 1e15;

/**
 * Inbox placement for a list of rows, where a row stands for its group. A row waits on you when
 * any of its threads does: it never counts as working and stays at the top of the inbox until
 * you answer. Otherwise it comes back whenever any of its threads does.
 */
export function workGroupInbox<T extends WorkGroupThread & NeedsYouShell & InboxThreadInput>(
  groupByThreadKey: ReadonlyMap<string, WorkGroup<T>>,
  inbox: {
    readonly isWorking: (thread: T) => boolean;
    readonly returnedAt: (thread: T) => number | undefined;
  },
) {
  const threadsOf = (thread: T) => [
    thread,
    ...(groupByThreadKey.get(threadKey(thread))?.children ?? []).map((entry) => entry.thread),
  ];
  const waitsOnYou = (thread: T) =>
    threadsOf(thread).some((member) => threadNeedsYouKind(member) !== null);
  return {
    isWorking: (thread: T) => inbox.isWorking(thread) && !waitsOnYou(thread),
    returnedAt: (thread: T) => {
      const latest = Math.max(
        ...threadsOf(thread).map((member) => inboxReturnAt(member, inbox.returnedAt)),
      );
      return waitsOnYou(thread) ? WAITING_ON_YOU_LIFT + latest : latest;
    },
  };
}
