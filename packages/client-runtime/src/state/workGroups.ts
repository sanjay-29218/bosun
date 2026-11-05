import { headquartersBotId, type ThreadCrewRequestTag } from "@t3tools/contracts";

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
  /** `member` names the crew member a delegated thread runs as; the lead has none. */
  readonly feature?: {
    readonly id: string;
    readonly title: string;
    readonly member?: string | undefined;
    readonly parentFeatureId?: string | undefined;
  } | null;
  readonly crewRequest?: ThreadCrewRequestTag | null;
  readonly lineage?: { readonly relationshipToParent: "fork" | "subagent" | null };
}

export interface WorkGroupEntry<T> {
  readonly thread: T;
  /** "Planner", "Planner · try 2", or the thread's title outside the crew. */
  readonly label: string;
}

export interface WorkGroup<T> {
  readonly key: string;
  readonly kind: "feature" | "request";
  readonly title: string;
  readonly primary: T;
  /** The group's other threads, oldest first. */
  readonly children: ReadonlyArray<WorkGroupEntry<T>>;
  /** Child features folded under this feature's row by `nestChildFeatureGroups`. */
  readonly childFeatures?: ReadonlyArray<WorkGroup<T>>;
}

/** The key a thread groups under, or null for a thread outside any work. */
function workGroupKey(thread: WorkGroupThread): string | null {
  // A plain subagent works on the feature but shows under the thread that started it.
  if (
    thread.feature &&
    !thread.feature.member &&
    thread.lineage?.relationshipToParent === "subagent"
  ) {
    return null;
  }
  if (thread.feature) return `${thread.environmentId}:feature:${thread.feature.id}`;
  if (thread.crewRequest) return `${thread.environmentId}:request:${thread.crewRequest.id}`;
  return null;
}

/** A thread named by the work it is on: "Clip crop editing · Planner", "Triage issues · Builder". */
export function workThreadLabel(
  thread: Pick<WorkGroupThread, "title" | "feature" | "crewRequest">,
): string {
  if (thread.feature) {
    return thread.feature.member
      ? `${thread.feature.title} · ${thread.feature.member}`
      : thread.feature.title;
  }
  if (thread.crewRequest) return `${thread.crewRequest.title} · ${thread.crewRequest.member}`;
  return thread.title;
}

const threadKey = (thread: WorkGroupThread) => `${thread.environmentId}:${thread.id}`;

const byCreated = (left: WorkGroupThread, right: WorkGroupThread) =>
  left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);

/** Labels threads by crew member, numbering repeat attempts. */
function labelEntries<T extends WorkGroupThread>(threads: ReadonlyArray<T>) {
  const seen = new Map<string, number>();
  return threads.map((thread) => {
    const base = thread.feature?.member ?? thread.crewRequest?.member ?? thread.title;
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
  return {
    key,
    kind: primary.feature ? "feature" : "request",
    title: primary.feature?.title || primary.crewRequest?.title || primary.title,
    primary,
    children: labelEntries([...members].sort(byCreated)).filter(
      (entry) => entry.thread !== primary,
    ),
  };
}

/** A feature's lead: its first thread that no crew member runs. */
const featureLead = <T extends WorkGroupThread>(threads: ReadonlyArray<T>) =>
  threads.filter((thread) => !thread.feature?.member && !thread.crewRequest).sort(byCreated)[0];

/**
 * Folds tagged threads into one row per feature or bot request. `visible` are the threads the
 * list may show; `history` are threads that only appear inside a group, such as a feature's
 * crew threads. A feature's row is its lead, else its latest thread; a request's row is the latest attempt of the thread the chain started with.
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
        featureLead(candidates) ??
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
 * the list shows for it. The feature is settled when the row's
 * primary is, as the list files it.
 */
export function featureRows<T extends WorkGroupThread & { readonly archivedAt: unknown }>(
  threads: ReadonlyArray<T>,
): ReadonlyMap<string, WorkGroup<T>> {
  const featureThreads = threads.filter((thread) => thread.feature && thread.archivedAt === null);
  const { groupByThreadKey } = groupWorkThreads(featureThreads);
  const rows = new Map<string, WorkGroup<T>>();
  for (const group of groupByThreadKey.values()) {
    rows.set(`${group.primary.environmentId}:${group.primary.feature!.id}`, group);
  }
  return rows;
}

/**
 * The chats the board shows beside its features: the thread list's own rows outside any
 * feature, with a bot request's handoffs folded into one. Subagents, threads delegated under
 * another and bot headquarters stay off it, as they do in the list.
 */
export function boardChatThreads<
  T extends WorkGroupThread & {
    readonly archivedAt: unknown;
    readonly delegatedFrom: unknown;
    readonly lineage: {
      readonly relationshipToParent: string | null;
      readonly listed?: boolean | undefined;
    };
  },
>(threads: ReadonlyArray<T>): T[] {
  const rows = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !thread.feature &&
      (thread.lineage.relationshipToParent !== "subagent" || thread.lineage.listed === true) &&
      thread.delegatedFrom == null &&
      headquartersBotId(thread.id) === null,
  );
  return groupWorkThreads(rows).primaries;
}

/** A group's threads, its primary first. */
export const workGroupThreads = <T>(group: WorkGroup<T>) => [
  group.primary,
  ...group.children.map((entry) => entry.thread),
];

/** A group's threads and its child features' threads. */
export const workGroupAllThreads = <T>(group: WorkGroup<T>): T[] => [
  ...workGroupThreads(group),
  ...(group.childFeatures ?? []).flatMap(workGroupAllThreads),
];

type SettlingThread = WorkGroupThread & { readonly settledOverride?: string | null };

/** A child feature is finished once its lead is settled, as Lineage reads it. */
export function childFeatureFinished<T extends SettlingThread>(group: WorkGroup<T>): boolean {
  return (workGroupLead(group) ?? group.primary).settledOverride === "settled";
}

/**
 * Folds each child feature's row under its top ancestor's row, when that row is listed. A child
 * whose ancestors aren't listed, or for which `standsAlone` holds, stays its own row. Children
 * list open ones first, then finished ones, each oldest first.
 */
export function nestChildFeatureGroups<T extends SettlingThread>(
  primaries: ReadonlyArray<T>,
  groupByThreadKey: ReadonlyMap<string, WorkGroup<T>>,
  options: { readonly standsAlone?: (child: WorkGroup<T>, parent: T) => boolean } = {},
): { readonly primaries: T[]; readonly groupByThreadKey: Map<string, WorkGroup<T>> } {
  const featureKey = (environmentId: string, featureId: string) => `${environmentId}:${featureId}`;
  const rowKeyByFeature = new Map<string, string>();
  for (const thread of primaries) {
    const group = groupByThreadKey.get(threadKey(thread));
    if (group?.kind === "feature" && thread.feature) {
      rowKeyByFeature.set(featureKey(thread.environmentId, thread.feature.id), threadKey(thread));
    }
  }
  const parentRowKey = (rowKey: string) => {
    const primary = groupByThreadKey.get(rowKey)!.primary;
    const parentId = primary.feature?.parentFeatureId;
    return parentId === undefined
      ? undefined
      : rowKeyByFeature.get(featureKey(primary.environmentId, parentId));
  };
  // A cycle has no top, so its features stay their own rows.
  const rootRowKey = (rowKey: string) => {
    const seen = new Set([rowKey]);
    let root = rowKey;
    for (let parent = parentRowKey(root); parent !== undefined; parent = parentRowKey(root)) {
      if (seen.has(parent)) return rowKey;
      seen.add(parent);
      root = parent;
    }
    return root;
  };
  const childrenByRoot = new Map<string, WorkGroup<T>[]>();
  for (const rowKey of rowKeyByFeature.values()) {
    const root = rootRowKey(rowKey);
    if (root === rowKey) continue;
    const child = groupByThreadKey.get(rowKey)!;
    if (options.standsAlone?.(child, groupByThreadKey.get(root)!.primary)) continue;
    childrenByRoot.set(root, [...(childrenByRoot.get(root) ?? []), child]);
  }
  if (childrenByRoot.size === 0) {
    return { primaries: [...primaries], groupByThreadKey: new Map(groupByThreadKey) };
  }
  const folded = new Set<string>();
  const nested = new Map(groupByThreadKey);
  for (const [root, children] of childrenByRoot) {
    for (const child of children) {
      folded.add(threadKey(child.primary));
      nested.delete(threadKey(child.primary));
    }
    nested.set(root, {
      ...groupByThreadKey.get(root)!,
      childFeatures: [...children].sort(
        (left, right) =>
          Number(childFeatureFinished(left)) - Number(childFeatureFinished(right)) ||
          byCreated(left.primary, right.primary),
      ),
    });
  }
  return {
    primaries: primaries.filter((thread) => !folded.has(threadKey(thread))),
    groupByThreadKey: nested,
  };
}

const threadWaitsOnYou = (thread: WorkGroupThread & NeedsYouShell) =>
  threadNeedsYouKind(thread) !== null;

/** What a parent row's chip says about its child features, the same on every client. */
export function childFeatureSummary<T extends WorkGroupThread & NeedsYouShell>(
  group: WorkGroup<T>,
  isRunning: (thread: T) => boolean,
) {
  const children = group.childFeatures ?? [];
  const needsYou = children.filter((child) =>
    workGroupThreads(child).some(threadWaitsOnYou),
  ).length;
  const running = children.filter(
    (child) =>
      !workGroupThreads(child).some(threadWaitsOnYou) && workGroupThreads(child).some(isRunning),
  ).length;
  const total = children.length;
  const label = [
    `${total} ${total === 1 ? "child" : "children"}`,
    ...(needsYou > 0 ? [`${needsYou} needs you`] : []),
    ...(running > 0 ? [`${running} running`] : []),
  ].join(" · ");
  return { total, running, needsYou, label, compactLabel: String(total) };
}

/** The child feature `routeThreadKey` belongs to, if it is folded under `group`. */
export function routeChildFeature<T extends WorkGroupThread>(
  group: WorkGroup<T>,
  routeThreadKey: string | null,
): WorkGroup<T> | undefined {
  if (routeThreadKey === null) return undefined;
  return group.childFeatures?.find((child) =>
    workGroupThreads(child).some((thread) => threadKey(thread) === routeThreadKey),
  );
}

/** Who a group answers to: a bot request's first role, or a feature's lead (its project manager). */
export function workGroupLead<T extends WorkGroupThread>(group: WorkGroup<T>): T | null {
  if (group.kind === "request") return group.primary;
  return featureLead(workGroupThreads(group)) ?? null;
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

/**
 * The one thread of a feature or request that shows under its row: the first waiting on you,
 * among its own threads and then, unless `own`, its child features', named by the child.
 */
export function waitingWorkGroupEntry<T extends WorkGroupThread & NeedsYouShell>(
  group: WorkGroup<T>,
  scope: "all" | "own" = "all",
): WorkGroupEntry<T> | undefined {
  const own = group.children.find((entry) => threadWaitsOnYou(entry.thread));
  if (own || scope === "own") return own;
  for (const child of group.childFeatures ?? []) {
    if (threadWaitsOnYou(child.primary)) return { thread: child.primary, label: child.title };
    const entry = child.children.find((candidate) => threadWaitsOnYou(candidate.thread));
    if (entry) return { thread: entry.thread, label: `${child.title} · ${entry.label}` };
  }
  return undefined;
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
    const open = workGroupAllThreads(group).find(
      (thread) => thread !== group.primary && threadKey(thread) === routeThreadKey,
    );
    if (open && open !== waiting) return rowKey;
  }
  return null;
}

/** Past any real timestamp, so rows waiting on you sort ahead of the rest. */
const WAITING_ON_YOU_LIFT = 1e15;

/**
 * Inbox placement for a list of rows, where a row stands for its group and its child features.
 * A row waits on you when any of its threads does: it never counts as working and stays at the top of the inbox until
 * you answer. Otherwise it works while any of its threads does, and comes back whenever any does.
 */
export function workGroupInbox<T extends WorkGroupThread & NeedsYouShell & InboxThreadInput>(
  groupByThreadKey: ReadonlyMap<string, WorkGroup<T>>,
  inbox: {
    readonly isWorking: (thread: T) => boolean;
    readonly returnedAt: (thread: T) => number | undefined;
  },
) {
  const threadsOf = (thread: T) => {
    const group = groupByThreadKey.get(threadKey(thread));
    return group ? workGroupAllThreads(group) : [thread];
  };
  const waitsOnYou = (thread: T) =>
    threadsOf(thread).some((member) => threadNeedsYouKind(member) !== null);
  return {
    isWorking: (thread: T) => threadsOf(thread).some(inbox.isWorking) && !waitsOnYou(thread),
    returnedAt: (thread: T) => {
      const latest = Math.max(
        ...threadsOf(thread).map((member) => inboxReturnAt(member, inbox.returnedAt)),
      );
      return waitsOnYou(thread) ? WAITING_ON_YOU_LIFT + latest : latest;
    },
  };
}
