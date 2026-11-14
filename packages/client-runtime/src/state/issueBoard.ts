import type {
  EnvironmentId,
  FeatureBoardCard,
  ProjectId,
  RepositoryIssue,
  RepositoryMilestone,
  Ticket,
} from "@t3tools/contracts";

/**
 * Pure todo logic for the board, shared by web and mobile. Issues come from `issues.list` and tickets
 * from `tickets.list`, one read each per project. A feature works on an issue when its linked
 * issue has the same URL, and on a ticket when it links the same ticket.
 */
export interface EnvironmentIssue extends RepositoryIssue {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** Set for a Bosun ticket, whose `number` is its `T-` number and whose `url` is empty. */
  readonly ticketId: string | null;
}

/** A ticket as an Issues-view row; tickets have no milestone, parent, labels or assignees. */
export const ticketIssue = (ticket: Ticket, environmentId: EnvironmentId): EnvironmentIssue => ({
  number: ticket.number,
  title: ticket.title,
  url: "",
  state: ticket.state,
  updatedAt: ticket.updatedAt,
  closedAt: ticket.closedAt,
  milestone: null,
  parent: null,
  subIssues: null,
  labels: [],
  assignees: [],
  environmentId,
  projectId: ticket.projectId,
  ticketId: ticket.id,
});

/** `T-12` for a ticket, `#12` for an issue. */
export const issueRef = (issue: { readonly number: number; readonly ticketId?: string | null }) =>
  issue.ticketId ? `T-${issue.number}` : `#${issue.number}`;

export interface EnvironmentMilestone extends RepositoryMilestone {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export const issueKey = (issue: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly number: number;
  readonly ticketId?: string | null;
}) => `${issue.environmentId}:${issue.projectId}:${issue.ticketId ? "T-" : ""}${issue.number}`;

const issueUrlKey = (environmentId: EnvironmentId, url: string) =>
  `${environmentId}:${url.split(/[?#]/u)[0]!.replace(/\/+$/u, "").toLowerCase()}`;
const ticketKey = (environmentId: EnvironmentId, ticketId: string) =>
  `${environmentId}:ticket:${ticketId}`;
const linkKey = (
  environmentId: EnvironmentId,
  issue: { readonly url: string; readonly ticketId?: string | null | undefined },
) =>
  issue.ticketId ? ticketKey(environmentId, issue.ticketId) : issueUrlKey(environmentId, issue.url);

const isOpenFeature = (card: FeatureBoardCard) => card.status === "open";

/**
 * The feature working on each issue, by environment and issue URL. When several features link
 * one issue, an open one wins over a closed one, then the most recently moved.
 */
export function featuresByIssue<
  Card extends FeatureBoardCard & { readonly environmentId: EnvironmentId },
>(cards: ReadonlyArray<Card>): ReadonlyMap<string, Card> {
  const byIssue = new Map<string, Card>();
  for (const card of cards) {
    if (!card.issue) continue;
    const key = linkKey(card.environmentId, card.issue);
    const current = byIssue.get(key);
    if (
      !current ||
      (isOpenFeature(card) && !isOpenFeature(current)) ||
      (isOpenFeature(card) === isOpenFeature(current) && card.updatedAt > current.updatedAt)
    ) {
      byIssue.set(key, card);
    }
  }
  return byIssue;
}

export function featureForIssue<Card>(
  features: ReadonlyMap<string, Card>,
  issue: EnvironmentIssue,
): Card | null {
  return features.get(linkKey(issue.environmentId, issue)) ?? null;
}

/** Issues whose title, `#number` or `T-number` holds every word of the query. */
export function matchesIssueSearch(issue: EnvironmentIssue, text: string): boolean {
  if (!text) return true;
  const haystack = [
    issue.title,
    issueRef(issue),
    issue.milestone?.title,
    ...issue.labels.map((label) => label.name),
    ...issue.assignees.map((assignee) => assignee.login),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.split(" ").every((word) => haystack.includes(word));
}

/**
 * Where an issue sits in its repository's structure: its own key and its parent's, both by URL so
 * an issue of another repository never matches by number.
 */
export interface IssuePlace {
  readonly key: string;
  readonly parentKey: string | null;
}

/** The URL of issue `number` in the same repository as `url`. */
const siblingIssueUrl = (url: string, number: number) =>
  url.split(/[?#]/u)[0]!.replace(/\/issues\/\d+\/?$/u, `/issues/${number}`);

export function issuePlace(
  environmentId: EnvironmentId,
  issue: { readonly url: string; readonly parent?: number | null | undefined },
): IssuePlace | null {
  if (!issue.url) return null;
  return {
    key: issueUrlKey(environmentId, issue.url),
    parentKey:
      issue.parent == null
        ? null
        : issueUrlKey(environmentId, siblingIssueUrl(issue.url, issue.parent)),
  };
}

/** The loaded issues by URL, and each parent's loaded sub-issues in list order. */
export interface IssueStructureIndex {
  readonly byKey: ReadonlyMap<string, EnvironmentIssue>;
  readonly partsByKey: ReadonlyMap<string, ReadonlyArray<EnvironmentIssue>>;
}

export function indexIssueStructure(issues: ReadonlyArray<EnvironmentIssue>): IssueStructureIndex {
  const byKey = new Map<string, EnvironmentIssue>();
  const partsByKey = new Map<string, EnvironmentIssue[]>();
  for (const issue of issues) {
    const place = issue.ticketId ? null : issuePlace(issue.environmentId, issue);
    if (!place) continue;
    byKey.set(place.key, issue);
    if (place.parentKey === null) continue;
    const parts = partsByKey.get(place.parentKey);
    if (parts) parts.push(issue);
    else partsByKey.set(place.parentKey, [issue]);
  }
  return { byKey, partsByKey };
}

/** The loaded issue at `url`, or its parent when `parent` is given. */
export function structureIssue(
  index: IssueStructureIndex,
  environmentId: EnvironmentId,
  url: string,
  parent?: number,
): EnvironmentIssue | null {
  if (!url) return null;
  return (
    index.byKey.get(
      issueUrlKey(environmentId, parent === undefined ? url : siblingIssueUrl(url, parent)),
    ) ?? null
  );
}

export interface IssuePartGroups<Item> {
  /** The parts shown under each head, by the head's key, in input order. */
  readonly parts: ReadonlyMap<string, ReadonlyArray<Item>>;
  /** Keys of the parts, which show under their head instead of in their own place. */
  readonly nested: ReadonlySet<string>;
}

/**
 * Nests each item under its parent when the parent is among `items` too. One level only: a part
 * whose parent is itself a part stays in its own place. Order is kept, and each item is placed
 * once, so a board renders a head's parts right after it and skips them elsewhere.
 */
export function groupIssueParts<Item>(
  items: ReadonlyArray<Item>,
  placeOf: (item: Item) => IssuePlace | null,
): IssuePartGroups<Item> {
  const places = items.map(placeOf);
  const present = new Map<string, IssuePlace>();
  for (const place of places) if (place) present.set(place.key, place);
  const parts = new Map<string, Item[]>();
  const nested = new Set<string>();
  places.forEach((place, index) => {
    const head = place?.parentKey ? present.get(place.parentKey) : undefined;
    if (!place || !head || head.key === place.key) return;
    // A head that is itself nested would hide its parts two levels deep.
    if (head.parentKey !== null && present.has(head.parentKey)) return;
    const list = parts.get(head.key);
    if (list) list.push(items[index]!);
    else parts.set(head.key, [items[index]!]);
    nested.add(place.key);
  });
  return { parts, nested };
}
