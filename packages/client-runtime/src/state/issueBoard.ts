import type {
  EnvironmentId,
  FeatureBoardCard,
  ProjectId,
  RepositoryIssue,
  RepositoryMilestone,
} from "@t3tools/contracts";

import { featurePhase } from "./crewBoard.ts";

/**
 * Pure Issues-view logic shared by web and mobile. Issues come from `issues.list`, one read per
 * project; a feature works on an issue when its linked issue has the same URL.
 */
export interface EnvironmentIssue extends RepositoryIssue {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export interface EnvironmentMilestone extends RepositoryMilestone {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export const issueKey = (issue: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly number: number;
}) => `${issue.environmentId}:${issue.projectId}:${issue.number}`;

const issueUrlKey = (environmentId: EnvironmentId, url: string) =>
  `${environmentId}:${url.split(/[?#]/u)[0]!.replace(/\/+$/u, "").toLowerCase()}`;

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
    const key = issueUrlKey(card.environmentId, card.issue.url);
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
  return features.get(issueUrlKey(issue.environmentId, issue.url)) ?? null;
}

// ── Lanes ────────────────────────────────────────────────────────────

const ISSUE_LANES = ["todo", "in-crew", "in-review", "done"] as const;
export type IssueLane = (typeof ISSUE_LANES)[number];

export const ISSUE_LANE_LABELS: Record<IssueLane, string> = {
  todo: "Todo",
  "in-crew": "In crew",
  "in-review": "In review",
  done: "Done",
};

/**
 * Where an issue stands with the crew. Closed is Done whatever its feature says; an open issue
 * whose feature reached verify, ship or done waits on review; a running feature is In crew.
 */
export function issueLane(issue: RepositoryIssue, feature: FeatureBoardCard | null): IssueLane {
  if (issue.state === "closed") return "done";
  if (!feature || feature.state === "cancelled") return "todo";
  const phase = featurePhase(feature);
  if (phase === "verify" || phase === "ship" || phase === "done") return "in-review";
  return feature.started ? "in-crew" : "todo";
}

// ── Grouping ─────────────────────────────────────────────────────────

export type IssueGroupBy = "milestone" | "status" | "none";

export interface IssueRow {
  readonly issue: EnvironmentIssue;
  /** 1 for a sub-issue drawn under its parent. */
  readonly depth: 0 | 1;
}

export interface IssueGroup {
  readonly key: string;
  readonly title: string;
  readonly lane: IssueLane | null;
  /** The group's milestone, when grouped by one that is still open. */
  readonly milestone: EnvironmentMilestone | null;
  readonly rows: ReadonlyArray<IssueRow>;
  /** Issues in the group, sub-issues included. */
  readonly count: number;
}

/** Open first, then the most recently updated. */
const compareIssues = (left: RepositoryIssue, right: RepositoryIssue) =>
  left.state === right.state
    ? right.updatedAt.localeCompare(left.updatedAt)
    : left.state === "open"
      ? -1
      : 1;

/**
 * Orders a group's issues, drawing each sub-issue under its parent when `nested` and the parent
 * is in the same group. A sub-issue whose parent is elsewhere stays at the top level.
 */
export function nestIssueRows(
  issues: ReadonlyArray<EnvironmentIssue>,
  nested: boolean,
): ReadonlyArray<IssueRow> {
  const sorted = [...issues].sort(compareIssues);
  if (!nested) return sorted.map((issue) => ({ issue, depth: 0 }));
  const present = new Set(sorted.map(issueKey));
  const children = new Map<string, EnvironmentIssue[]>();
  const roots: EnvironmentIssue[] = [];
  for (const issue of sorted) {
    const parentKey = issue.parent === null ? null : issueKey({ ...issue, number: issue.parent });
    if (parentKey !== null && present.has(parentKey)) {
      const siblings = children.get(parentKey) ?? [];
      siblings.push(issue);
      children.set(parentKey, siblings);
    } else {
      roots.push(issue);
    }
  }
  return roots.flatMap((issue) => [
    { issue, depth: 0 as const },
    ...(children.get(issueKey(issue)) ?? []).map((child) => ({ issue: child, depth: 1 as const })),
  ]);
}

/**
 * Issues in display groups. By milestone, open milestones come in due order (undated last),
 * then milestones read only from their issues, then "No milestone". Empty status lanes stay,
 * so the order reads the same every time; empty milestones are dropped.
 */
export function groupIssues(input: {
  readonly issues: ReadonlyArray<EnvironmentIssue>;
  readonly milestones: ReadonlyArray<EnvironmentMilestone>;
  readonly groupBy: IssueGroupBy;
  readonly nested: boolean;
  readonly laneFor: (issue: EnvironmentIssue) => IssueLane;
  /** Prefixes milestone titles when issues come from more than one project. */
  readonly projectTitle?: (issue: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => string | null;
}): ReadonlyArray<IssueGroup> {
  const group = (
    key: string,
    title: string,
    issues: ReadonlyArray<EnvironmentIssue>,
    extra: Pick<IssueGroup, "lane" | "milestone">,
  ): IssueGroup => ({
    key,
    title,
    ...extra,
    rows: nestIssueRows(issues, input.nested),
    count: issues.length,
  });

  if (input.groupBy === "none") {
    return [group("all", "All issues", input.issues, { lane: null, milestone: null })];
  }

  if (input.groupBy === "status") {
    const byLane = new Map<IssueLane, EnvironmentIssue[]>(ISSUE_LANES.map((lane) => [lane, []]));
    for (const issue of input.issues) byLane.get(input.laneFor(issue))!.push(issue);
    return ISSUE_LANES.map((lane) =>
      group(lane, ISSUE_LANE_LABELS[lane], byLane.get(lane)!, { lane, milestone: null }),
    );
  }

  const known = new Map(input.milestones.map((milestone) => [issueKey(milestone), milestone]));
  const byMilestone = new Map<string, { title: string; issues: EnvironmentIssue[] }>();
  const unscheduled: EnvironmentIssue[] = [];
  for (const issue of input.issues) {
    if (!issue.milestone) {
      unscheduled.push(issue);
      continue;
    }
    const key = issueKey({ ...issue, number: issue.milestone.number });
    const entry = byMilestone.get(key) ?? { title: issue.milestone.title, issues: [] };
    entry.issues.push(issue);
    byMilestone.set(key, entry);
  }
  const projectCount = new Set(
    input.issues.map((issue) => `${issue.environmentId}:${issue.projectId}`),
  ).size;
  const titled = (title: string, owner: EnvironmentIssue | EnvironmentMilestone) => {
    const project = projectCount > 1 ? input.projectTitle?.(owner) : null;
    return project ? `${project} · ${title}` : title;
  };
  const dueOrder = (milestone: EnvironmentMilestone | undefined) => milestone?.dueOn ?? "￿";
  const groups = [...byMilestone]
    .sort(([leftKey, left], [rightKey, right]) => {
      const leftMilestone = known.get(leftKey);
      const rightMilestone = known.get(rightKey);
      if (!leftMilestone !== !rightMilestone) return leftMilestone ? -1 : 1;
      return (
        dueOrder(leftMilestone).localeCompare(dueOrder(rightMilestone)) ||
        left.title.localeCompare(right.title)
      );
    })
    .map(([key, entry]) =>
      group(key, titled(entry.title, entry.issues[0]!), entry.issues, {
        lane: null,
        milestone: known.get(key) ?? null,
      }),
    );
  if (unscheduled.length > 0) {
    groups.push(group("none", "No milestone", unscheduled, { lane: null, milestone: null }));
  }
  return groups;
}

/** Issues whose title or `#number` holds every word of the query. */
export function matchesIssueSearch(issue: RepositoryIssue, text: string): boolean {
  if (!text) return true;
  const haystack = [
    issue.title,
    `#${issue.number}`,
    issue.milestone?.title,
    ...issue.labels.map((label) => label.name),
    ...issue.assignees.map((assignee) => assignee.login),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return text.split(" ").every((word) => haystack.includes(word));
}

/** A milestone's closed share, 0 to 1; an empty milestone has none. */
export function milestoneProgress(milestone: RepositoryMilestone): number {
  const total = milestone.openIssues + milestone.closedIssues;
  return total === 0 ? 0 : milestone.closedIssues / total;
}
