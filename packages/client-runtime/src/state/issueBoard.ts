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

const isOpenFeature = (card: FeatureBoardCard) =>
  card.state !== "done" && card.state !== "cancelled";

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
      (isOpenFeature(card) === isOpenFeature(current) && card.stateSince > current.stateSince)
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
