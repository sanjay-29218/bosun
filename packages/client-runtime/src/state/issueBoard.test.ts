import { EnvironmentId, ProjectId, type FeatureBoardCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  featureForIssue,
  featuresByIssue,
  issueKey,
  matchesIssueSearch,
  ticketIssue,
  type EnvironmentIssue,
} from "./issueBoard.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

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

describe("search", () => {
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
});
