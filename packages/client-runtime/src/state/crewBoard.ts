import {
  featureIssueRef,
  headquartersBotId,
  headquartersProjectId,
  isNestedSubagentLineage,
  type OrchestrationV2AppThreadLineage,
  type EnvironmentId,
  type ProjectId,
  type ProjectRemoteBot,
  type FeatureBoardCard,
  type ThreadId,
} from "@t3tools/contracts";

import { resolveThreadCurrentPullRequestLink } from "../threadPullRequests.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { threadHasPlanReady, type PlanReadyInput } from "./threadInbox.ts";

/**
 * Pure Features-board logic shared by web and mobile. Cards come from `features.board`; where a
 * started feature stands comes from its lead's and crew's threads, which every client already
 * holds as thread shells.
 */
export interface EnvironmentFeatureCard extends FeatureBoardCard {
  readonly environmentId: EnvironmentId;
}

export const featureCardKey = (card: {
  readonly environmentId: EnvironmentId;
  readonly featureId: string;
}) => `${card.environmentId}:${card.featureId}`;

/**
 * A thread's part in its project's board signal: it changes when the thread starts, stops, or
 * starts waiting on you, never on streamed messages. Starting a feature makes its lead's
 * thread, so a board re-reads when the joined signal of its project's threads changes.
 */
export const threadBoardSignal = (
  shell: Pick<
    EnvironmentThreadShell,
    "id" | "runtime" | "latestRun" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
) =>
  `${shell.id}/${shell.runtime?.status ?? "-"}/${shell.latestRun?.status ?? "-"}/${shell.hasPendingApprovals ? 1 : 0}${shell.hasPendingUserInput ? 1 : 0}`;

// ── Needs you ────────────────────────────────────────────────────────

const NEEDS_YOU_KINDS = ["approval", "question"] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

/** The shell fields Needs you reads. */
export type NeedsYouShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "archivedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "updatedAt"
> & {
  readonly runtime: { readonly updatedAt: string } | null;
};

/** A thread waiting on you: a tool approval or a question. */
export function threadNeedsYouKind(shell: NeedsYouShell): NeedsYouKind | null {
  if (shell.archivedAt !== null) return null;
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "question";
  return null;
}

/** The shell fields `threadAsksYou` reads. */
export type AskShell = NeedsYouShell &
  Omit<PlanReadyInput, "hasPendingUserInput" | "runtime"> &
  Pick<EnvironmentThreadShell, "pendingSubagentRequest" | "pendingUserInputUserOnly"> & {
    readonly lineage: Pick<OrchestrationV2AppThreadLineage, "relationshipToParent" | "listed">;
    readonly runtime: (PlanReadyInput["runtime"] & { readonly updatedAt: string }) | null;
  };

/**
 * One ask of the person: an approval, a question, or a plan ready for review. A nested
 * subagent's plain question is its coordinator's to answer. `pendingSubagentRequest` mirrors a
 * child's ask that already counts on the child, so it never counts again.
 */
export function threadAsksYou(shell: AskShell): boolean {
  const kind = threadNeedsYouKind(shell);
  if (kind === "approval") return true;
  if (kind === "question") {
    return !isNestedSubagentLineage(shell.lineage) || shell.pendingUserInputUserOnly === true;
  }
  return shell.archivedAt === null && threadHasPlanReady(shell);
}

// ── Status board: Todo, Working, Needs you, Done ─────────────────────

const FEATURE_COLUMNS = ["todo", "working", "needs-you", "done"] as const;
export type FeatureColumn = (typeof FEATURE_COLUMNS)[number];

/** The shell fields a column reads from a feature's threads, or from a chat. */
export type BoardThreadShell = NeedsYouShell &
  Pick<EnvironmentThreadShell, "pendingSubagentRequest" | "runtime"> & {
    readonly latestRun?:
      | (Pick<LatestRun, "runId"> & { readonly status?: LatestRun["status"] })
      | null;
  };
type LatestRun = NonNullable<EnvironmentThreadShell["latestRun"]>;

/**
 * Whether the feature's lead reported it finished (t3_feature_finish) during its latest run, so
 * nothing has happened in it since. A lead that merely stopped hasn't.
 */
export function featureFinished(
  card: Pick<FeatureBoardCard, "leadThreadId" | "report">,
  threads: ReadonlyArray<BoardThreadShell>,
): boolean {
  if (card.report?.outcome !== "finished" || card.leadThreadId === null) return false;
  const lead = threads.find((thread) => thread.id === card.leadThreadId);
  return lead?.latestRun?.runId === card.report.runId;
}

const threadWaitsOnYou = (shell: BoardThreadShell) =>
  threadNeedsYouKind(shell) !== null || shell.pendingSubagentRequest != null;

/**
 * A chat thread's column, read the way its sidebar row is: waiting on an approval or answer,
 * running, or finished. Chats skip Todo, which holds work not started yet.
 */
export function threadBoardColumn(shell: BoardThreadShell): Exclude<FeatureColumn, "todo"> {
  if (threadWaitsOnYou(shell)) return "needs-you";
  return threadRuntimeIsActive(shell.runtime) ? "working" : "done";
}

/**
 * Where a feature stands, from `threads`, its lead's and crew's threads. A started feature works
 * while any of them runs, and otherwise waits on you: its lead stops to ask you or to report.
 * Closing a feature moves it to Done, and so does a child reporting itself finished.
 */
export function featureColumn(
  card: Pick<FeatureBoardCard, "status" | "leadThreadId" | "parentFeatureId" | "report">,
  threads: ReadonlyArray<BoardThreadShell>,
): FeatureColumn {
  if (card.status === "closed") return "done";
  if (card.leadThreadId === null) return "todo";
  const live = threads.filter((thread) => thread.archivedAt === null);
  if (live.some(threadWaitsOnYou)) return "needs-you";
  if (live.some((thread) => threadRuntimeIsActive(thread.runtime))) return "working";
  // A child that reported finished handed its work to its parent's lead, not to the person.
  return card.parentFeatureId !== undefined && featureFinished(card, live) ? "done" : "needs-you";
}

// ── Status words ─────────────────────────────────────────────────────

/** The only words a crew member, lead or feature shows for where it stands. */
export type CrewStatus = "working" | "needs-input" | "waiting" | "done" | "failed";
/** A feature can also be one nobody has started. */
export type FeatureStatus = CrewStatus | "not-started";

export const FEATURE_STATUS_LABELS: Record<FeatureStatus, string> = {
  working: "Working",
  "needs-input": "Needs input",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  "not-started": "Not started",
};

export const threadFailed = (shell: Pick<BoardThreadShell, "runtime" | "latestRun">): boolean =>
  shell.runtime?.status === "failed" || shell.latestRun?.status === "failed";

/**
 * Where a feature stands, from its lead's and crew's threads, and the thread that puts it there:
 * the one asking the person something, else the one running. A lead that stopped short of
 * finishing is Waiting; one that reported the feature finished is Done.
 */
export function featureProgress<Shell extends BoardThreadShell>(
  card: Pick<FeatureBoardCard, "status" | "leadThreadId" | "parentFeatureId" | "report">,
  threads: ReadonlyArray<Shell>,
): {
  readonly column: FeatureColumn;
  readonly status: FeatureStatus;
  readonly thread: Shell | null;
} {
  const live = threads.filter((thread) => thread.archivedAt === null);
  const column = featureColumn(card, live);
  switch (column) {
    case "todo":
      return { column, status: "not-started", thread: null };
    case "working":
      return {
        column,
        status: "working",
        thread: live.find((thread) => threadRuntimeIsActive(thread.runtime)) ?? null,
      };
    case "done":
      return { column, status: "done", thread: null };
    case "needs-you": {
      const asking = live.find(threadWaitsOnYou);
      if (asking) return { column, status: "needs-input", thread: asking };
      if (featureFinished(card, live)) return { column, status: "done", thread: null };
      const lead = live.find((thread) => thread.id === card.leadThreadId);
      return { column, status: lead && threadFailed(lead) ? "failed" : "waiting", thread: null };
    }
  }
}

// ── Work tab: Needs input, Working, Ready for review, Done ──────────

export const WORK_GROUPS = ["needs-input", "working", "review", "done"] as const;
export type WorkGroupId = (typeof WORK_GROUPS)[number];

export const WORK_GROUP_LABELS: Record<WorkGroupId, string> = {
  "needs-input": "Needs input",
  working: "Working",
  review: "Ready for review",
  done: "Done",
};

/** A thread's pull request; `state` is null when only its number is known. */
export interface WorkPullRequest {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed" | "merged" | null;
}

export type PullRequestShell = Pick<
  EnvironmentThreadShell,
  "pullRequests" | "linkedPullRequest" | "branchPullRequest"
>;

/** The pull request a thread shows: its current link with its last known state, else its number. */
export function threadPullRequest(shell: Partial<PullRequestShell>): WorkPullRequest | null {
  const link = resolveThreadCurrentPullRequestLink(shell.pullRequests ?? []);
  if (link) return { number: link.number, url: link.url, state: link.snapshot?.state ?? null };
  const fallback = shell.linkedPullRequest ?? shell.branchPullRequest ?? null;
  return fallback ? { number: fallback.number, url: fallback.url, state: null } : null;
}

/** A feature's pull request: its lead's, else the first of its crew's. */
export function featurePullRequest(
  card: Pick<FeatureBoardCard, "leadThreadId">,
  threads: ReadonlyArray<BoardThreadShell & Partial<PullRequestShell>>,
): WorkPullRequest | null {
  const lead = threads.find((thread) => thread.id === card.leadThreadId);
  const own = lead ? threadPullRequest(lead) : null;
  if (own) return own;
  for (const thread of threads) {
    const pullRequest = threadPullRequest(thread);
    if (pullRequest) return pullRequest;
  }
  return null;
}

/**
 * A started feature's Work group. Anything asking the person comes first, then a running turn,
 * even with a PR open. Done means merged; an open PR, or a lead that
 * reported the work finished, is Ready for review. A lead that stopped short stays in Working.
 */
export function featureWorkGroup(
  card: Pick<FeatureBoardCard, "status" | "leadThreadId" | "parentFeatureId" | "report">,
  threads: ReadonlyArray<BoardThreadShell & Partial<PullRequestShell>>,
): WorkGroupId {
  const live = threads.filter((thread) => thread.archivedAt === null);
  if (live.some(threadWaitsOnYou)) return "needs-input";
  if (live.some((thread) => threadRuntimeIsActive(thread.runtime))) return "working";
  const pullRequest = featurePullRequest(card, threads);
  if (pullRequest?.state === "merged") return "done";
  if (
    (pullRequest && pullRequest.state !== "closed") ||
    card.status === "closed" ||
    featureFinished(card, live)
  )
    return "review";
  return "working";
}

/**
 * What every surface says a feature is: its Work group, with Working split into Waiting and
 * Failed, or Not started.
 */
export type WorkRowStatus = WorkGroupId | "waiting" | "failed" | "not-started";

export const WORK_ROW_LABELS: Record<WorkRowStatus, string> = {
  ...WORK_GROUP_LABELS,
  waiting: FEATURE_STATUS_LABELS.waiting,
  failed: FEATURE_STATUS_LABELS.failed,
  "not-started": FEATURE_STATUS_LABELS["not-started"],
};

/**
 * A feature's Work group and what every surface says it is. Done means merged, so a lead that
 * reported the feature finished reads Ready for review until its PR merges. Count by `status`:
 * a feature nobody started has no Work group of its own.
 */
export function featureWorkStatus<Shell extends BoardThreadShell & Partial<PullRequestShell>>(
  card: Pick<FeatureBoardCard, "status" | "leadThreadId" | "parentFeatureId" | "report">,
  threads: ReadonlyArray<Shell>,
): {
  readonly group: WorkGroupId;
  readonly status: WorkRowStatus;
  readonly thread: Shell | null;
} {
  const group = featureWorkGroup(card, threads);
  if (card.leadThreadId === null) return { group, status: "not-started", thread: null };
  const progress = featureProgress(card, threads);
  const status =
    progress.status === "failed" || (group === "working" && progress.status === "waiting")
      ? progress.status
      : group;
  return { group, status, thread: progress.thread };
}

/** Chats follow the same PR groups; completed work without a merged PR can be settled. */
export function chatWorkGroup(shell: BoardThreadShell & Partial<PullRequestShell>): WorkGroupId {
  const column = threadBoardColumn(shell);
  if (column === "needs-you") return "needs-input";
  if (column === "working") return "working";
  const pullRequest = threadPullRequest(shell);
  if (pullRequest?.state === "merged") return "done";
  return pullRequest && pullRequest.state !== "closed" ? "review" : "working";
}

export interface WorkGroupCards<Card extends EnvironmentFeatureCard = EnvironmentFeatureCard> {
  readonly group: WorkGroupId;
  readonly cards: ReadonlyArray<Card>;
}

/** Started features by Work group. Needs input puts the longest wait first; the others the newest. */
export function groupFeaturesByWork<Card extends EnvironmentFeatureCard>(
  cards: ReadonlyArray<Card>,
  threads: ReadonlyMap<string, ReadonlyArray<BoardThreadShell & Partial<PullRequestShell>>>,
): ReadonlyArray<WorkGroupCards<Card>> {
  const groups = new Map<WorkGroupId, { card: Card; movedAt: string }[]>(
    WORK_GROUPS.map((group) => [group, []]),
  );
  for (const card of cards) {
    if (card.leadThreadId === null) continue;
    const own = threads.get(featureCardKey(card)) ?? [];
    groups.get(featureWorkGroup(card, own))!.push({ card, movedAt: featureMovedAt(card, own) });
  }
  return WORK_GROUPS.map((group) => ({
    group,
    cards: [...groups.get(group)!]
      .sort((a, b) =>
        group === "needs-input"
          ? a.movedAt.localeCompare(b.movedAt)
          : b.movedAt.localeCompare(a.movedAt),
      )
      .map((entry) => entry.card),
  }));
}

/**
 * The thread opening a feature lands on: the one asking the person something, longest waiting
 * first, else its lead. A lead waiting only on its crew gives way to the member that asks, and
 * a parent's threads include its children's, so a child's question opens from the parent.
 */
export function featureOpenThreadId(
  card: Pick<FeatureBoardCard, "leadThreadId">,
  threads: ReadonlyArray<BoardThreadShell>,
): ThreadId | null {
  const since = (thread: BoardThreadShell) => thread.runtime?.updatedAt ?? thread.updatedAt;
  const asking = threads
    .filter((thread) => threadNeedsYouKind(thread) !== null)
    .sort((a, b) => since(a).localeCompare(since(b)));
  return asking[0]?.id ?? card.leadThreadId;
}

/** When a feature last moved: its newest thread change, else its own. */
function featureMovedAt(
  card: Pick<FeatureBoardCard, "updatedAt">,
  threads: ReadonlyArray<Pick<EnvironmentThreadShell, "updatedAt">>,
): string {
  return threads.reduce(
    (latest, thread) => (thread.updatedAt > latest ? thread.updatedAt : latest),
    card.updatedAt,
  );
}

/** Each feature's threads, by `environmentId:featureId`, from every shell a client holds. */
export function threadsByFeature<
  Shell extends Pick<EnvironmentThreadShell, "environmentId" | "feature">,
>(shells: ReadonlyArray<Shell>): ReadonlyMap<string, ReadonlyArray<Shell>> {
  const byFeature = new Map<string, Shell[]>();
  for (const shell of shells) {
    if (!shell.feature) continue;
    const key = featureCardKey({ environmentId: shell.environmentId, featureId: shell.feature.id });
    const threads = byFeature.get(key);
    if (threads) threads.push(shell);
    else byFeature.set(key, [shell]);
  }
  return byFeature;
}

/**
 * Child features sit under their top parent, numbered in order, so a big piece of work reads as
 * one card. A child whose parent isn't among `cards`, or an open child of a closed parent, stands
 * on its own. The parent's `threads`
 * entry gains its open children's threads, so its column follows them; others keep their own.
 */
export function nestFeatureChildren<Card extends EnvironmentFeatureCard, Shell>(
  cards: ReadonlyArray<Card>,
  threads: ReadonlyMap<string, ReadonlyArray<Shell>>,
): {
  readonly cards: ReadonlyArray<Card>;
  readonly children: ReadonlyMap<string, ReadonlyArray<Card>>;
  readonly threads: ReadonlyMap<string, ReadonlyArray<Shell>>;
} {
  const byKey = new Map(cards.map((card) => [featureCardKey(card), card]));
  const parentOf = (card: Card) =>
    card.parentFeatureId === undefined
      ? undefined
      : byKey.get(featureCardKey({ ...card, featureId: card.parentFeatureId }));
  const rootOf = (card: Card) => {
    const seen = new Set<Card>([card]);
    let root = card;
    for (let parent = parentOf(root); parent && !seen.has(parent); parent = parentOf(root)) {
      seen.add(parent);
      root = parent;
    }
    return root;
  };
  const top: Card[] = [];
  const children = new Map<string, Card[]>();
  for (const card of cards) {
    const root = rootOf(card);
    // An open child of a closed parent stands alone, or Done would hide it.
    if (root === card || (card.status === "open" && root.status === "closed")) {
      top.push(card);
      continue;
    }
    const key = featureCardKey(root);
    children.set(key, [...(children.get(key) ?? []), card]);
  }
  const merged = new Map(threads);
  for (const [key, list] of children) {
    list.sort(
      (a, b) =>
        (a.number ?? Number.MAX_SAFE_INTEGER) - (b.number ?? Number.MAX_SAFE_INTEGER) ||
        a.createdAt.localeCompare(b.createdAt),
    );
    merged.set(key, [
      ...(threads.get(key) ?? []),
      ...list
        .filter((child) => child.status === "open")
        .flatMap((child) => threads.get(featureCardKey(child)) ?? []),
    ]);
  }
  return { cards: top, children, threads: merged };
}

export interface FeatureColumnGroup<Card extends EnvironmentFeatureCard = EnvironmentFeatureCard> {
  readonly column: FeatureColumn;
  readonly cards: ReadonlyArray<Card>;
}

/** Every column in order. Needs you puts the longest wait first; the others the newest. */
export function groupFeaturesByColumn<Card extends EnvironmentFeatureCard>(
  cards: ReadonlyArray<Card>,
  threads: ReadonlyMap<string, ReadonlyArray<BoardThreadShell>>,
): ReadonlyArray<FeatureColumnGroup<Card>> {
  const groups = new Map<FeatureColumn, { card: Card; movedAt: string }[]>(
    FEATURE_COLUMNS.map((column) => [column, []]),
  );
  for (const card of cards) {
    const own = threads.get(featureCardKey(card)) ?? [];
    groups.get(featureColumn(card, own))!.push({ card, movedAt: featureMovedAt(card, own) });
  }
  return FEATURE_COLUMNS.map((column) => ({
    column,
    cards: [...groups.get(column)!]
      .sort((a, b) =>
        column === "needs-you"
          ? a.movedAt.localeCompare(b.movedAt)
          : b.movedAt.localeCompare(a.movedAt),
      )
      .map((entry) => entry.card),
  }));
}

// ── Bots ─────────────────────────────────────────────────────────────

/** The key `countNeedsYouByBot` counts under: bots belong to one environment. */
export const botNeedsYouKey = (environmentId: EnvironmentId, botId: string) =>
  `${environmentId}:${botId}`;

/**
 * Asks waiting on you per bot (`threadAsksYou`), keyed by `botNeedsYouKey`, from the shells and
 * project shells every client already has. Threads in a project with no bot count for no bot,
 * and a project manager's thread counts for its manager, not its project's bot.
 */
export function countNeedsYouByBot(
  shells: ReadonlyArray<AskShell & { readonly projectId: ProjectId }>,
  projects: ReadonlyArray<BotOwnedProject>,
): ReadonlyMap<string, number> {
  const ownerKey = createThreadBotKeyResolver(projects);
  const counts = new Map<string, number>();
  for (const shell of shells) {
    if (headquartersProjectId(shell.id) !== null || !threadAsksYou(shell)) continue;
    const key = ownerKey(shell);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Asks waiting on you per project, keyed by `${environmentId}:${projectId}`, manager threads included. */
export function countNeedsYouByProject(
  shells: ReadonlyArray<AskShell & { readonly projectId: ProjectId }>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const shell of shells) {
    if (!threadAsksYou(shell)) continue;
    const key = `${shell.environmentId}:${shell.projectId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface BotOwnedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly botId?: string | null | undefined;
  /** An owner on another environment; its threads count for that bot. */
  readonly remoteBot?: ProjectRemoteBot | null | undefined;
}

/**
 * The `botNeedsYouKey` of the bot a thread works for, or undefined when its project has no bot
 * or isn't loaded. A headquarters belongs to its bot, not to the project it lives in.
 */
export function createThreadBotKeyResolver(projects: ReadonlyArray<BotOwnedProject>) {
  const owners = new Map(
    projects.flatMap((project) =>
      project.remoteBot != null
        ? [
            [
              `${project.environmentId}:${project.id}`,
              botNeedsYouKey(project.remoteBot.environmentId, project.remoteBot.botId),
            ],
          ]
        : project.botId == null
          ? []
          : [
              [
                `${project.environmentId}:${project.id}`,
                botNeedsYouKey(project.environmentId, project.botId),
              ],
            ],
    ),
  );
  return (shell: {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly projectId: ProjectId;
  }): string | undefined => {
    const headquarters = headquartersBotId(shell.id);
    return headquarters !== null
      ? botNeedsYouKey(shell.environmentId, headquarters)
      : owners.get(`${shell.environmentId}:${shell.projectId}`);
  };
}

export interface NeedsYouItem<Shell extends NeedsYouShell = EnvironmentThreadShell> {
  readonly key: string;
  readonly kind: NeedsYouKind;
  readonly since: string;
  readonly shell: Shell;
}

export interface NeedsYouGroup<Shell extends NeedsYouShell = EnvironmentThreadShell> {
  readonly kind: NeedsYouKind;
  readonly items: ReadonlyArray<NeedsYouItem<Shell>>;
}

/** Every thread waiting on you, grouped by kind and oldest first. */
export function collectNeedsYou<Shell extends NeedsYouShell>(
  shells: ReadonlyArray<Shell>,
): ReadonlyArray<NeedsYouGroup<Shell>> {
  const items: NeedsYouItem<Shell>[] = [];
  for (const shell of shells) {
    const kind = threadNeedsYouKind(shell);
    if (!kind) continue;
    items.push({
      key: `${shell.environmentId}:${shell.id}`,
      kind,
      since: shell.runtime?.updatedAt ?? shell.updatedAt,
      shell,
    });
  }
  return NEEDS_YOU_KINDS.map((kind) => ({
    kind,
    items: items
      .filter((item) => item.kind === kind)
      .sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key)),
  })).filter((group) => group.items.length > 0);
}

/** The ask ⌘⇧Y opens: the one (`threadAsksYou`) that has waited longest, whatever its kind. */
export function oldestAsk<Shell extends AskShell>(shells: ReadonlyArray<Shell>): Shell | null {
  const since = (shell: Shell) => shell.runtime?.updatedAt ?? shell.updatedAt;
  let oldest: Shell | null = null;
  for (const shell of shells) {
    if (threadAsksYou(shell) && (oldest === null || since(shell) < since(oldest))) oldest = shell;
  }
  return oldest;
}

// ── Search ───────────────────────────────────────────────────────────

/** A feature's short name: its linked issue or ticket, else its own F-<number>. */
export function featureRef(card: Pick<FeatureBoardCard, "issue" | "number">): string | null {
  if (card.issue) return featureIssueRef(card.issue);
  return card.number === undefined ? null : `F-${card.number}`;
}

/** `extra` carries text the card shows from elsewhere, such as its project and branch. */
export function matchesFeatureSearch(
  card: FeatureBoardCard,
  query: string,
  extra: ReadonlyArray<string | null | undefined> = [],
): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [
    card.title,
    featureRef(card),
    card.issue?.title,
    card.issue?.milestone,
    ...extra,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

// ── Drag and actions ─────────────────────────────────────────────────

export type FeatureCardActionId = "start" | "close" | "reopen";

/** What a card's menu offers. Everything else happens in the lead's thread. */
export function featureCardActions(
  card: Pick<FeatureBoardCard, "status" | "leadThreadId">,
): ReadonlyArray<FeatureCardActionId> {
  if (card.status === "closed") return ["reopen"];
  return card.leadThreadId === null ? ["start", "close"] : ["close"];
}

/** The buttons a board card shows, to act on it without opening it. */
export function featureCardQuickActions(
  card: Pick<FeatureBoardCard, "status" | "leadThreadId">,
): ReadonlyArray<FeatureCardActionId> {
  return card.status === "open" && card.leadThreadId === null ? ["start"] : [];
}

export const FEATURE_CARD_ACTION_LABELS: Record<FeatureCardActionId, string> = {
  start: "Start feature",
  close: "Close feature",
  reopen: "Reopen feature",
};
