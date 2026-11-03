import {
  CAPTAIN_BOT_ID,
  featureIssueRef,
  headquartersBotId,
  type EnvironmentId,
  type ProjectId,
  type FeatureBoardCard,
} from "@t3tools/contracts";

import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";

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

// ── Status board: Todo, Working, Needs you, Done ─────────────────────

const FEATURE_COLUMNS = ["todo", "working", "needs-you", "done"] as const;
export type FeatureColumn = (typeof FEATURE_COLUMNS)[number];

export const FEATURE_COLUMN_LABELS: Record<FeatureColumn, string> = {
  todo: "Todo",
  working: "Working",
  "needs-you": "Needs you",
  done: "Done",
};

/** The shell fields a column reads from a feature's threads, or from a chat. */
export type BoardThreadShell = NeedsYouShell &
  Pick<EnvironmentThreadShell, "pendingSubagentRequest" | "runtime">;

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
 * Only closing a feature moves it to Done.
 */
export function featureColumn(
  card: Pick<FeatureBoardCard, "status" | "leadThreadId">,
  threads: ReadonlyArray<BoardThreadShell>,
): FeatureColumn {
  if (card.status === "closed") return "done";
  if (card.leadThreadId === null) return "todo";
  const live = threads.filter((thread) => thread.archivedAt === null);
  if (live.some(threadWaitsOnYou)) return "needs-you";
  return live.some((thread) => threadRuntimeIsActive(thread.runtime)) ? "working" : "needs-you";
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
    byFeature.set(key, [...(byFeature.get(key) ?? []), shell]);
  }
  return byFeature;
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
 * Threads waiting on you per bot, keyed by `botNeedsYouKey`, from the shells and project
 * shells every client already has. A project without a `botId` (an older server) is Captain's.
 */
export function countNeedsYouByBot(
  shells: ReadonlyArray<NeedsYouShell & { readonly projectId: ProjectId }>,
  projects: ReadonlyArray<BotOwnedProject>,
): ReadonlyMap<string, number> {
  const ownerKey = createThreadBotKeyResolver(projects);
  const counts = new Map<string, number>();
  for (const shell of shells) {
    if (threadNeedsYouKind(shell) === null) continue;
    const key = ownerKey(shell);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface BotOwnedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly botId?: string | undefined;
}

/**
 * The `botNeedsYouKey` of the bot a thread works for, or undefined when its project isn't
 * loaded. A headquarters belongs to its bot, not to the project it lives in.
 */
export function createThreadBotKeyResolver(projects: ReadonlyArray<BotOwnedProject>) {
  const owners = new Map(
    projects.map((project) => [
      `${project.environmentId}:${project.id}`,
      project.botId ?? CAPTAIN_BOT_ID,
    ]),
  );
  return (shell: {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly projectId: ProjectId;
  }): string | undefined => {
    const botId =
      headquartersBotId(shell.id) ?? owners.get(`${shell.environmentId}:${shell.projectId}`);
    return botId === undefined ? undefined : botNeedsYouKey(shell.environmentId, botId);
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

/** The item ⌘⇧Y opens: the one that has waited longest, whatever its kind. */
export function oldestNeedsYouItem<Shell extends NeedsYouShell>(
  groups: ReadonlyArray<NeedsYouGroup<Shell>>,
): NeedsYouItem<Shell> | null {
  let oldest: NeedsYouItem<Shell> | null = null;
  for (const group of groups)
    for (const item of group.items) if (oldest === null || item.since < oldest.since) oldest = item;
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

/** The only board moves: into Done closes, out of Done reopens. */
export function featureDropAction(
  card: Pick<FeatureBoardCard, "status">,
  target: "done" | "open",
): "close" | "reopen" | null {
  if (target === "done") return card.status === "open" ? "close" : null;
  return card.status === "closed" ? "reopen" : null;
}

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
