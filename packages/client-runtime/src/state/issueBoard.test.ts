import { EnvironmentId, ProjectId, type FeatureBoardCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  featureForIssue,
  featuresByIssue,
  groupIssues,
  issueKey,
  issueLane,
  matchesIssueSearch,
  milestoneProgress,
  nestIssueRows,
  ticketIssue,
  type EnvironmentIssue,
  type EnvironmentMilestone,
} from "./issueBoard.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");

const issue = (number: number, overrides: Partial<EnvironmentIssue> = {}): EnvironmentIssue => ({
  environmentId,
  projectId,
  number,
  title: `Issue ${number}`,
  url: `https://github.com/o/r/issues/${number}`,
  state: "open",
  updatedAt: `2026-10-${String(number).padStart(2, "0")}T00:00:00.000Z`,
  closedAt: null,
  milestone: null,
  parent: null,
  subIssues: null,
  labels: [],
  assignees: [],
  ticketId: null,
  ...overrides,
});

const milestone = (
  number: number,
  overrides: Partial<EnvironmentMilestone> = {},
): EnvironmentMilestone => ({
  environmentId,
  projectId,
  number,
  title: `M${number}`,
  url: `https://github.com/o/r/milestone/${number}`,
  dueOn: null,
  openIssues: 1,
  closedIssues: 1,
  ...overrides,
});

const feature = (
  overrides: Partial<FeatureBoardCard> = {},
): FeatureBoardCard & { readonly environmentId: EnvironmentId } => ({
  environmentId,
  featureId: "f",
  projectId,
  title: "Feature",
  issue: null,
  workflow: { id: "w", name: "W", revision: 1, latestRevision: 1 },
  state: "working",
  started: true,
  stateSince: "2026-10-01T00:00:00.000Z",
  stage: {
    stepId: "build",
    index: 2,
    total: 4,
    role: "builder",
    attempt: 1,
    gate: false,
    takenOver: false,
  },
  threadId: null,
  detail: null,
  yourCall: null,
  queuedAt: null,
  ...overrides,
});

const linkedTo = (number: number) => ({
  url: `https://github.com/o/r/issues/${number}`,
  number,
  title: `Issue ${number}`,
  state: "open" as const,
  milestone: null,
  subIssues: null,
});

describe("features by issue", () => {
  it("matches an issue to its feature by URL, preferring an open feature", () => {
    const done = feature({ featureId: "done", state: "done", issue: linkedTo(7) });
    const running = feature({
      featureId: "running",
      issue: { ...linkedTo(7), url: "https://github.com/O/R/issues/7/" },
      stateSince: "2026-09-01T00:00:00.000Z",
    });
    const byIssue = featuresByIssue([done, running]);
    expect(featureForIssue(byIssue, issue(7))?.featureId).toBe("running");
    expect(featureForIssue(byIssue, issue(8))).toBeNull();
  });

  it("matches a ticket by its ticket, never an issue with the same number", () => {
    const ticket = ticketIssue(
      {
        id: "ticket:a",
        projectId,
        number: 7,
        title: "Sketch",
        description: "",
        state: "open",
        closedReason: null,
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
        closedAt: null,
      },
      environmentId,
    );
    const onTicket = feature({
      featureId: "ticket",
      issue: { ...linkedTo(7), url: "", ticketId: "ticket:a" },
    });
    const onIssue = feature({ featureId: "issue", issue: linkedTo(7) });
    const byIssue = featuresByIssue([onTicket, onIssue]);
    expect(featureForIssue(byIssue, ticket)?.featureId).toBe("ticket");
    expect(featureForIssue(byIssue, issue(7))?.featureId).toBe("issue");
    expect(issueKey(ticket)).not.toBe(issueKey(issue(7)));
    expect(matchesIssueSearch(ticket, "t-7")).toBe(true);
    expect(matchesIssueSearch(ticket, "#7")).toBe(false);
  });
});

describe("issue lanes", () => {
  it("places an issue by its state and its feature's phase", () => {
    expect(issueLane(issue(1), null)).toBe("todo");
    expect(issueLane(issue(1, { state: "closed" }), feature())).toBe("done");
    expect(issueLane(issue(1), feature())).toBe("in-crew");
    expect(issueLane(issue(1), feature({ started: false, stage: null }))).toBe("todo");
    expect(issueLane(issue(1), feature({ state: "cancelled" }))).toBe("todo");
    expect(
      issueLane(
        issue(1),
        feature({ stage: { ...feature().stage!, stepId: "review", role: "reviewer" } }),
      ),
    ).toBe("in-review");
    expect(issueLane(issue(1), feature({ state: "done" }))).toBe("in-review");
  });
});

describe("grouping", () => {
  it("draws sub-issues under a parent in the same group, newest first", () => {
    const parent = issue(1);
    const child = issue(3, { parent: 1 });
    const orphan = issue(4, { parent: 99 });
    const closed = issue(9, { state: "closed" });
    const rows = nestIssueRows([closed, child, parent, orphan], true);
    expect(rows.map((row) => [row.issue.number, row.depth])).toEqual([
      [4, 0],
      [1, 0],
      [3, 1],
      [9, 0],
    ]);
    expect(nestIssueRows([child, parent], false).map((row) => row.depth)).toEqual([0, 0]);
  });

  it("groups by milestone in due order, with unscheduled issues last", () => {
    const groups = groupIssues({
      issues: [
        issue(1, { milestone: { number: 2, title: "Later" } }),
        issue(2, { milestone: { number: 1, title: "Soon" } }),
        issue(3, { milestone: { number: 5, title: "Closed one" } }),
        issue(4),
      ],
      milestones: [
        milestone(1, { title: "Soon", dueOn: "2026-11-01T00:00:00Z" }),
        milestone(2, { title: "Later" }),
      ],
      groupBy: "milestone",
      nested: true,
      laneFor: () => "todo",
    });
    expect(
      groups.map((group) => [group.title, group.count, group.milestone?.number ?? null]),
    ).toEqual([
      ["Soon", 1, 1],
      ["Later", 1, 2],
      ["Closed one", 1, null],
      ["No milestone", 1, null],
    ]);
  });

  it("names milestones by project when several projects are shown", () => {
    const groups = groupIssues({
      issues: [
        issue(1, { milestone: { number: 1, title: "Beta" } }),
        issue(2, { projectId: otherProjectId, milestone: { number: 1, title: "Beta" } }),
      ],
      milestones: [],
      groupBy: "milestone",
      nested: false,
      laneFor: () => "todo",
      projectTitle: (owner) => (owner.projectId === projectId ? "bosun" : "site"),
    });
    expect(groups.map((group) => group.title)).toEqual(["bosun · Beta", "site · Beta"]);
  });

  it("keeps every status lane, in order", () => {
    const groups = groupIssues({
      issues: [issue(1), issue(2, { state: "closed" })],
      milestones: [],
      groupBy: "status",
      nested: false,
      laneFor: (entry) => (entry.state === "closed" ? "done" : "todo"),
    });
    expect(groups.map((group) => [group.lane, group.count])).toEqual([
      ["todo", 1],
      ["in-crew", 0],
      ["in-review", 0],
      ["done", 1],
    ]);
  });
});

describe("search and progress", () => {
  it("searches title, number, milestone, labels and assignees", () => {
    const labelled = issue(12, {
      title: "Crash on start",
      milestone: { number: 1, title: "Beta" },
      labels: [{ name: "bug", color: "d73a4a" }],
      assignees: [{ login: "octocat", avatarUrl: "" }],
    });
    for (const text of ["crash", "#12", "beta", "bug", "octocat", "crash bug"]) {
      expect(matchesIssueSearch(labelled, text)).toBe(true);
    }
    expect(matchesIssueSearch(labelled, "feature")).toBe(false);
  });

  it("measures a milestone by its closed share", () => {
    expect(milestoneProgress(milestone(1, { openIssues: 1, closedIssues: 3 }))).toBe(0.75);
    expect(milestoneProgress(milestone(1, { openIssues: 0, closedIssues: 0 }))).toBe(0);
  });
});
