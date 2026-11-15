import { EnvironmentId, ProjectId, type FeatureBoardCard } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  featureForIssue,
  featuresByIssue,
  groupIssueParts,
  indexIssueStructure,
  issueKey,
  issuePlace,
  matchesIssueSearch,
  structureIssue,
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
  status: "open",
  leadThreadId: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
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
    const done = feature({ featureId: "done", status: "closed", issue: linkedTo(7) });
    const running = feature({
      featureId: "running",
      issue: { ...linkedTo(7), url: "https://github.com/O/R/issues/7/" },
      updatedAt: "2026-09-01T00:00:00.000Z",
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

describe("issue structure", () => {
  const placeOf = (item: EnvironmentIssue) => issuePlace(item.environmentId, item);
  const numbers = (items: ReadonlyArray<EnvironmentIssue> | undefined) =>
    items?.map((item) => item.number);

  it("indexes each parent's loaded parts by URL, never across repositories", () => {
    const elsewhere = issue(9, { url: "https://github.com/o/other/issues/9", parent: 48 });
    const index = indexIssueStructure([
      issue(48),
      issue(92, { parent: 48 }),
      issue(93, { parent: 48, state: "closed" }),
      elsewhere,
      issue(3, { ticketId: "ticket:3", url: "", parent: null }),
    ]);
    const parent = structureIssue(index, environmentId, issue(48).url);
    expect(parent?.number).toBe(48);
    expect(numbers(index.partsByKey.get(placeOf(parent!)!.key))).toEqual([92, 93]);
    expect(structureIssue(index, environmentId, issue(94).url, 48)?.number).toBe(48);
    expect(structureIssue(index, environmentId, elsewhere.url, 48)).toBeNull();
  });

  it("nests parts under a parent in the same list and leaves the rest in place", () => {
    const items = [
      issue(92, { parent: 48 }),
      issue(48, { parent: 10 }),
      issue(93, { parent: 48 }),
      issue(5, { parent: 48 }),
      issue(97),
      issue(60, { parent: 77 }),
    ];
    const grouped = groupIssueParts(items, placeOf);
    const head = placeOf(issue(48))!.key;
    // #10 isn't listed, so #48 heads its parts; #77 isn't either, so #60 stays put.
    expect(numbers(grouped.parts.get(head))).toEqual([92, 93, 5]);
    expect([...grouped.nested].toSorted()).toEqual(
      [92, 93, 5].map((number) => placeOf(issue(number))!.key).toSorted(),
    );
    expect(grouped.parts.size).toBe(1);
  });

  it("nests one level only", () => {
    const grouped = groupIssueParts(
      [issue(1), issue(2, { parent: 1 }), issue(3, { parent: 2 })],
      placeOf,
    );
    expect(numbers(grouped.parts.get(placeOf(issue(1))!.key))).toEqual([2]);
    expect(grouped.parts.has(placeOf(issue(2))!.key)).toBe(false);
    expect(grouped.nested.has(placeOf(issue(3))!.key)).toBe(false);
  });
});
