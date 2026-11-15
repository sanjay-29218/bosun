import {
  featureCardKey,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { listItemKey, nestListParts, type ListItem } from "./boardNesting.logic";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const url = (number: number) => `https://github.com/o/r/issues/${number}`;

const todo = (number: number, parent: number | null = null): EnvironmentIssue => ({
  environmentId,
  projectId,
  number,
  title: `Issue ${number}`,
  url: url(number),
  state: "open",
  updatedAt: "2026-11-01T00:00:00.000Z",
  closedAt: null,
  milestone: null,
  parent,
  subIssues: null,
  labels: [],
  assignees: [],
  ticketId: null,
});

/** A feature working on issue `number`, a sub-issue of `parent` when given. */
const feature = (
  id: string,
  number: number,
  parent: number | null = null,
): EnvironmentFeatureCard => ({
  environmentId,
  featureId: id,
  projectId,
  title: `Feature ${id}`,
  issue: {
    url: url(number),
    number,
    title: `Issue ${number}`,
    state: "open",
    milestone: null,
    subIssues: null,
    parent,
  },
  status: "open",
  leadThreadId: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const handlersWith = (children: ReadonlyMap<string, ReadonlyArray<EnvironmentFeatureCard>>) => ({
  // The board's read has nothing newer than what each feature recorded.
  issueAt: () => null,
  childrenFor: (card: EnvironmentFeatureCard) => children.get(featureCardKey(card)) ?? [],
});

const keys = (items: ReadonlyArray<ListItem | EnvironmentFeatureCard>) =>
  items.map((item) => ("kind" in item ? listItemKey(item) : featureCardKey(item)));

describe("nestListParts", () => {
  it("keeps a nested part's own child features under it", () => {
    const part = feature("f92", 92, 48);
    const grandchild = feature("f92-child", 120);
    const nesting = nestListParts(
      [{ section: "todo", cards: [part], todos: [todo(48)] }],
      handlersWith(new Map([[featureCardKey(part), [grandchild]]])),
      false,
    );
    const head: ListItem = { kind: "todo", issue: todo(48), section: "todo" };
    expect(keys(nesting.partsFor(head))).toEqual([featureCardKey(part)]);
    expect(nesting.shows({ kind: "card", card: part, section: "todo" })).toBe(false);
    expect(keys(nesting.childrenFor(part))).toEqual([featureCardKey(grandchild)]);
  });

  it("folds a child feature on one of the head's sub-issues with its parts, shown once", () => {
    const head = feature("f48", 48);
    const onSubIssue = feature("f92", 92, 48);
    const unrelated = feature("f-other", 130);
    const nesting = nestListParts(
      [{ section: "todo", cards: [head], todos: [todo(93, 48)] }],
      handlersWith(new Map([[featureCardKey(head), [onSubIssue, unrelated]]])),
      false,
    );
    expect(keys(nesting.partsFor({ kind: "card", card: head, section: "todo" }))).toEqual([
      featureCardKey(onSubIssue),
      listItemKey({ kind: "todo", issue: todo(93, 48), section: "todo" }),
    ]);
    // Only the child that isn't a sub-issue stays in the head's always-visible rows.
    expect(keys(nesting.childrenFor(head))).toEqual([featureCardKey(unrelated)]);
  });

  it("lifts a head whose only parts are child features in the milestone view", () => {
    const head = feature("f48", 48);
    const onSubIssue = feature("f92", 92, 48);
    const nesting = nestListParts(
      [{ section: "working", cards: [head], todos: [] }],
      handlersWith(new Map([[featureCardKey(head), [onSubIssue]]])),
      true,
    );
    expect(keys(nesting.lifted)).toEqual([featureCardKey(head)]);
    expect(nesting.shows({ kind: "card", card: head, section: "working" })).toBe(false);
  });
});
