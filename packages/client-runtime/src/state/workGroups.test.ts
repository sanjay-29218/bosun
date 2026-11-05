import {
  botHeadquartersThreadId,
  EnvironmentId,
  projectHeadquartersThreadId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortInboxThreadsByReturn } from "./threadInbox.ts";
import {
  boardChatThreads,
  childFeatureFinished,
  childFeatureSummary,
  featureRows,
  groupWorkThreads,
  nestChildFeatureGroups,
  resolveWorkGroupRouteRowKey,
  routeChildFeature,
  waitingWorkGroupEntry,
  workGroupAllThreads,
  workGroupInbox,
  workGroupLead,
  workGroupOf,
  workGroupOpenThread,
  workGroupThreads,
  workThreadLabel,
  type WorkGroupThread,
} from "./workGroups.ts";

const feature = { id: "f1", title: "Clip crop editing" };
const thread = (id: string, createdAt: string, fields: Partial<WorkGroupThread> = {}) => ({
  id,
  environmentId: "local",
  title: id,
  createdAt,
  updatedAt: createdAt,
  ...fields,
});
const member = (id: string, createdAt: string, name: string) =>
  thread(id, createdAt, { feature: { ...feature, member: name } });

describe("groupWorkThreads", () => {
  it("folds a feature into its lead's row, with its crew's threads from history", () => {
    const lead = thread("lead", "0", { feature, title: "Feature manager" });
    const plan = member("plan", "1", "Planner");
    const replan = member("replan", "2", "Planner");
    const build = member("build", "3", "Builder");
    const plain = thread("plain", "5");
    // A plain subagent works on the feature, but belongs to the thread that started it.
    const helper = thread("helper", "4", {
      feature,
      lineage: { relationshipToParent: "subagent" },
    });

    const { primaries, groupByThreadKey } = groupWorkThreads(
      [lead, build, plain],
      [plan, replan, helper],
    );

    expect(primaries.map((item) => item.id)).toEqual(["lead", "plain"]);
    const group = groupByThreadKey.get("local:lead")!;
    expect(group.kind).toBe("feature");
    expect(group.title).toBe("Clip crop editing");
    expect(group.children.map((entry) => entry.label)).toEqual([
      "Planner",
      "Planner · try 2",
      "Builder",
    ]);
  });

  it("keeps a project's manager and the tasks it hands out as rows of their own", () => {
    const manager = thread(projectHeadquartersThreadId("web"), "0", { title: "Project manager" });
    const task = thread("task", "1", {
      lineage: { relationshipToParent: "subagent" },
    });
    const lead = thread("lead", "2", { feature, title: "Feature manager" });

    const { primaries, groupByThreadKey } = groupWorkThreads([manager, task, lead], []);

    expect(primaries.map((item) => item.id)).toEqual([manager.id, "task", "lead"]);
    expect(groupByThreadKey.has(`local:${manager.id}`)).toBe(false);
  });

  it("keeps a feature's history out of the list when none of its threads are visible", () => {
    const { primaries, groupByThreadKey } = groupWorkThreads([], [member("plan", "1", "Planner")]);
    expect(primaries).toEqual([]);
    expect(groupByThreadKey.size).toBe(0);
  });

  it("rows a request chain on the latest attempt of the thread it started with", () => {
    const request = (member: string) => ({ id: "triage", title: "Triage open issues", member });
    const manager = thread("pm", "1", { crewRequest: request("Feature manager") });
    const builder = thread("builder", "2", { crewRequest: request("Builder") });
    const retry = thread("pm-retry", "3", { crewRequest: request("Feature manager") });

    const { primaries, groupByThreadKey } = groupWorkThreads([builder, manager, retry]);

    expect(primaries.map((item) => item.id)).toEqual(["pm-retry"]);
    const group = groupByThreadKey.get("local:pm-retry")!;
    expect(group.kind).toBe("request");
    expect(group.title).toBe("Triage open issues");
    expect(group.children.map((entry) => entry.label)).toEqual(["Feature manager", "Builder"]);
  });
});

const inboxThread = (
  id: string,
  createdAt: string,
  fields: {
    crewRequest?: WorkGroupThread["crewRequest"];
    hasPendingApprovals?: boolean;
  } = {},
) => ({
  id: ThreadId.make(id),
  environmentId: EnvironmentId.make("local"),
  title: id,
  createdAt,
  updatedAt: createdAt,
  unsettledAt: null,
  latestRun: null,
  archivedAt: null,
  crewRequest: fields.crewRequest ?? null,
  hasPendingApprovals: fields.hasPendingApprovals ?? false,
  hasPendingUserInput: false,
  runtime: null,
});

describe("featureRows", () => {
  it("rows a feature on its lead, leaving out archives", () => {
    const rows = featureRows([
      { ...member("plan", "1", "Planner"), archivedAt: null },
      { ...thread("lead", "0", { feature, title: "Lead" }), archivedAt: null },
      { ...thread("old-lead", "0", { feature }), archivedAt: "2026-10-01" },
      { ...thread("plain", "3"), archivedAt: null },
    ]);
    expect(
      [...rows].map(([key, group]) => [key, workGroupThreads(group).map((item) => item.id)]),
    ).toEqual([["local:f1", ["lead", "plan"]]]);
  });
});

describe("boardChatThreads", () => {
  it("keeps the list's own rows outside features, folding a request into one", () => {
    const row = (id: string, fields: Partial<WorkGroupThread> = {}, extra = {}) => ({
      ...thread(id, "1", fields),
      archivedAt: null,
      delegatedFrom: null,
      lineage: { relationshipToParent: null },
      ...extra,
    });
    const request = (member: string) => ({ id: "triage", title: "Triage", member });
    const chats = boardChatThreads([
      row("chat"),
      row("fork", {}, { lineage: { relationshipToParent: "fork" } }),
      row("subagent", {}, { lineage: { relationshipToParent: "subagent" } }),
      // A bot's task for this project is the project's work.
      row("handed-off", {}, { lineage: { relationshipToParent: "subagent", listed: true } }),
      row("delegated", {}, { delegatedFrom: { threadId: "elsewhere" } }),
      row("archived", {}, { archivedAt: "2026-10-01" }),
      row("stage", { feature }),
      row(botHeadquartersThreadId("captain")),
      row("pm", { createdAt: "0", crewRequest: request("Feature manager") }),
      row("builder", { crewRequest: request("Builder") }),
    ]);
    expect(chats.map((item) => item.id)).toEqual(["chat", "fork", "handed-off", "pm"]);
  });
});

describe("workGroupInbox", () => {
  it("keeps rows that wait on you out of Working and above newer rows", () => {
    const request = (member: string) => ({ id: "triage", title: "Triage", member });
    const manager = inboxThread("pm", "2026-10-28T10:00:00.000Z", {
      crewRequest: request("Feature manager"),
    });
    const builder = inboxThread("builder", "2026-10-28T12:00:00.000Z", {
      crewRequest: request("Builder"),
      hasPendingApprovals: true,
    });
    const asking = inboxThread("asking", "2026-10-28T09:00:00.000Z", {
      hasPendingApprovals: true,
    });
    const newer = inboxThread("newer", "2026-10-28T13:00:00.000Z");
    const { primaries, groupByThreadKey } = groupWorkThreads([manager, builder, asking, newer]);

    const inbox = workGroupInbox(groupByThreadKey, {
      isWorking: () => true,
      returnedAt: () => undefined,
    });

    expect(inbox.isWorking(manager)).toBe(false);
    expect(inbox.isWorking(newer)).toBe(true);
    expect(sortInboxThreadsByReturn(primaries, inbox.returnedAt).map((row) => row.id)).toEqual([
      "pm",
      "asking",
      "newer",
    ]);
  });

  it("counts a row as working while any of its threads works", () => {
    const lead = { ...inboxThread("lead", "1"), feature };
    const builder = {
      ...inboxThread("builder", "3"),
      feature: { ...feature, member: "Builder" },
    };
    const { primaries, groupByThreadKey } = groupWorkThreads([lead, builder]);
    const working = new Set<string>(["builder"]);
    const inbox = workGroupInbox(groupByThreadKey, {
      isWorking: (row) => working.has(row.id),
      returnedAt: () => undefined,
    });

    expect(primaries.map((row) => row.id)).toEqual(["lead"]);
    expect(inbox.isWorking(lead)).toBe(true);
    working.clear();
    expect(inbox.isWorking(lead)).toBe(false);
  });
});

describe("workGroupOpenThread", () => {
  it("opens the crew thread waiting on you, else the feature's lead", () => {
    const lead = { ...inboxThread("lead", "2026-10-28T09:00:00.000Z"), feature };
    const plan = {
      ...inboxThread("plan", "2026-10-28T10:00:00.000Z"),
      feature: { ...feature, member: "Planner" },
    };
    const waiting = {
      ...inboxThread("build", "2026-10-28T12:00:00.000Z", { hasPendingApprovals: true }),
      feature: { ...feature, member: "Builder" },
    };

    const group = workGroupOf(plan, [lead, plan, waiting])!;
    expect(group.primary.id).toBe("lead");
    expect(workGroupLead(group)?.id).toBe("lead");
    expect(workGroupOpenThread(group).id).toBe("build");
    expect(workGroupOpenThread(workGroupOf(plan, [lead, plan])!).id).toBe("lead");
  });
});

describe("workThreadLabel", () => {
  it("names a thread by its feature or request and its crew member", () => {
    expect(workThreadLabel(member("build", "1", "Builder"))).toBe("Clip crop editing · Builder");
    expect(workThreadLabel(thread("lead", "1", { feature }))).toBe("Clip crop editing");
    expect(
      workThreadLabel(
        thread("pm", "1", { crewRequest: { id: "r", title: "Triage", member: "Builder" } }),
      ),
    ).toBe("Triage · Builder");
    expect(workThreadLabel(thread("plain", "1"))).toBe("plain");
  });
});

describe("nestChildFeatureGroups", () => {
  const tag = (id: string, parentFeatureId?: string, memberName?: string) => ({
    id,
    title: id,
    ...(parentFeatureId ? { parentFeatureId } : {}),
    ...(memberName ? { member: memberName } : {}),
  });
  const shell = (
    id: string,
    createdAt: string,
    featureTag: ReturnType<typeof tag> | null,
    fields: { hasPendingUserInput?: boolean; settledOverride?: "settled" | null } = {},
  ) => ({
    ...inboxThread(id, createdAt),
    feature: featureTag,
    hasPendingUserInput: fields.hasPendingUserInput ?? false,
    settledOverride: fields.settledOverride ?? null,
  });
  const nest = (
    threads: ReadonlyArray<ReturnType<typeof shell>>,
    options?: Parameters<typeof nestChildFeatureGroups<ReturnType<typeof shell>>>[2],
  ) => {
    const grouped = groupWorkThreads(threads);
    return nestChildFeatureGroups(grouped.primaries, grouped.groupByThreadKey, options);
  };
  const rows = (nested: ReturnType<typeof nest>) =>
    nested.primaries.map((row) => [
      row.id,
      (nested.groupByThreadKey.get(`local:${row.id}`)?.childFeatures ?? []).map(
        (child) => child.primary.id,
      ),
    ]);

  it.each([
    {
      name: "folds children and grandchildren under the top row, finished ones last",
      threads: [
        shell("epic", "0", tag("epic")),
        shell("done", "1", tag("done", "epic"), { settledOverride: "settled" }),
        shell("child", "2", tag("child", "epic")),
        shell("child-crew", "3", tag("child", "epic", "Builder")),
        shell("grandchild", "4", tag("grandchild", "child")),
      ],
      expected: [["epic", ["child", "grandchild", "done"]]],
    },
    {
      name: "keeps a child whose parent isn't listed, and a separate feature, as rows",
      threads: [
        shell("orphan", "1", tag("orphan", "archived-epic")),
        shell("separate", "2", tag("separate")),
        shell("chat", "3", null),
      ],
      expected: [
        ["orphan", []],
        ["separate", []],
        ["chat", []],
      ],
    },
    {
      name: "folds a manager-started child under its parent feature, not beside it",
      threads: [
        shell(projectHeadquartersThreadId("web"), "0", null),
        shell("epic", "1", tag("epic")),
        shell("part", "2", tag("part", "epic")),
        shell("part-crew", "3", tag("part", "epic", "Builder")),
      ],
      expected: [
        [projectHeadquartersThreadId("web"), []],
        ["epic", ["part"]],
      ],
    },
    {
      name: "keeps features whose parents form a cycle as rows",
      threads: [shell("a", "1", tag("a", "b")), shell("b", "2", tag("b", "a"))],
      expected: [
        ["a", []],
        ["b", []],
      ],
    },
  ])("$name", ({ threads, expected }) => {
    expect(rows(nest(threads))).toEqual(expected);
  });

  it("lets a child stand alone when the caller says so", () => {
    const nested = nest(
      [
        shell("epic", "0", tag("epic"), { settledOverride: "settled" }),
        shell("asking", "1", tag("asking", "epic"), { hasPendingUserInput: true }),
        shell("quiet", "2", tag("quiet", "epic")),
      ],
      {
        standsAlone: (child, parent) =>
          parent.settledOverride === "settled" &&
          workGroupAllThreads(child).some((thread) => thread.hasPendingUserInput),
      },
    );
    expect(rows(nested)).toEqual([
      ["epic", ["quiet"]],
      ["asking", []],
    ]);
  });

  it("waits on you, works, opens and marks the parent row through its children", () => {
    const epic = shell("epic", "0", tag("epic"));
    const done = shell("done", "1", tag("done", "epic"), { settledOverride: "settled" });
    const child = shell("child", "2", tag("child", "epic"));
    const asking = shell("child-crew", "3", tag("child", "epic", "Builder"), {
      hasPendingUserInput: true,
    });
    const nested = nest([epic, done, child, asking]);
    const group = nested.groupByThreadKey.get("local:epic")!;

    expect(waitingWorkGroupEntry(group)).toEqual({ thread: asking, label: "child · Builder" });
    expect(waitingWorkGroupEntry(group, "own")).toBeUndefined();
    const inbox = workGroupInbox(nested.groupByThreadKey, {
      isWorking: (row) => row.id === "child",
      returnedAt: () => undefined,
    });
    expect(inbox.isWorking(epic)).toBe(false);
    expect(inbox.returnedAt(epic)).toBeGreaterThan(1e15);
    expect(childFeatureSummary(group, (row) => row.id === "child").label).toBe(
      "2 children · 1 needs you",
    );
    expect(childFeatureFinished(group.childFeatures![1]!)).toBe(true);
    expect(routeChildFeature(group, "local:child")?.primary.id).toBe("child");
  });

  it.each([
    { name: "a child's lead", route: "child", waiting: [], row: "local:epic" },
    // Opened directly, then collapsed: the parent row still stands for it.
    {
      name: "a waiting child's thread",
      route: "child-crew",
      waiting: ["child-crew"],
      row: "local:epic",
    },
    // The parent's own waiting crew shows under its row and marks itself.
    {
      name: "the parent's own waiting crew",
      route: "epic-crew",
      waiting: ["epic-crew"],
      row: null,
    },
    { name: "the parent itself", route: "epic", waiting: [], row: null },
  ])("marks the row for $name", ({ route, waiting, row }) => {
    const asks = (id: string) => ({ hasPendingUserInput: waiting.includes(id) });
    const nested = nest([
      shell("epic", "0", tag("epic")),
      shell("epic-crew", "1", tag("epic", undefined, "Planner"), asks("epic-crew")),
      shell("child", "2", tag("child", "epic")),
      shell("child-crew", "3", tag("child", "epic", "Builder"), asks("child-crew")),
    ]);
    expect(resolveWorkGroupRouteRowKey(nested.groupByThreadKey, `local:${route}`)).toBe(row);
  });

  it.each([
    { running: [], waiting: [], label: "2 children" },
    { running: ["b"], waiting: [], label: "2 children · 1 running" },
    { running: ["a", "b"], waiting: ["a"], label: "2 children · 1 needs you · 1 running" },
  ])("summarizes children as $label", ({ running, waiting, label }) => {
    const nested = nest([
      shell("epic", "0", tag("epic")),
      ...["a", "b"].map((id, index) =>
        shell(id, String(index + 1), tag(id, "epic"), {
          hasPendingUserInput: waiting.includes(id),
        }),
      ),
    ]);
    const group = nested.groupByThreadKey.get("local:epic")!;
    expect(childFeatureSummary(group, (row) => running.includes(row.id)).label).toBe(label);
  });
});
