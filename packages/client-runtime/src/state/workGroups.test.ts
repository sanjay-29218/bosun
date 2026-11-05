import { botHeadquartersThreadId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortInboxThreadsByReturn } from "./threadInbox.ts";
import {
  boardChatThreads,
  featureRows,
  groupWorkThreads,
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
