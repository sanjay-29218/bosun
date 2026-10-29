import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sortInboxThreadsByReturn } from "./threadInbox.ts";
import {
  groupWorkThreads,
  workGroupInbox,
  workGroupLead,
  workGroupOf,
  workGroupOpenThread,
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
const stage = (
  id: string,
  createdAt: string,
  stepId: string,
  index: number,
  state: "working" | "approval" | "done" = "done",
  current = false,
) => thread(id, createdAt, { feature, crew: { stepId, index, total: 4, state, current } });

describe("groupWorkThreads", () => {
  it("folds a feature into its current stage's row, with earlier stages from history", () => {
    const plan = stage("plan", "1", "plan", 1);
    const design1 = stage("design-1", "2", "design", 2);
    const design2 = stage("design-2", "3", "design", 2);
    const build = stage("build", "4", "build", 3, "approval", true);
    const lead = thread("lead", "0", { feature, title: "Lead" });
    const plain = thread("plain", "5");

    const { primaries, groupByThreadKey } = groupWorkThreads(
      [lead, build, plain],
      [plan, design1, design2],
    );

    expect(primaries.map((item) => item.id)).toEqual(["build", "plain"]);
    const group = groupByThreadKey.get("local:build")!;
    expect(group.title).toBe("Clip crop editing");
    expect(group.stages).toEqual(["done", "done", "needs-you", "pending"]);
    expect(group.stageLine).toBe("Build · 3/4");
    expect(group.children.map((entry) => entry.label)).toEqual([
      "Plan",
      "Design",
      "Design · try 2",
      "Lead",
    ]);
  });

  it("keeps a feature's history out of the list when none of its threads are visible", () => {
    const { primaries, groupByThreadKey } = groupWorkThreads([], [stage("plan", "1", "plan", 1)]);
    expect(primaries).toEqual([]);
    expect(groupByThreadKey.size).toBe(0);
  });

  it("rows a request chain on the latest attempt of the thread it started with", () => {
    const request = (member: string) => ({ id: "triage", title: "Triage open issues", member });
    const manager = thread("pm", "1", { crewRequest: request("Project manager") });
    const builder = thread("builder", "2", { crewRequest: request("Builder") });
    const retry = thread("pm-retry", "3", { crewRequest: request("Project manager") });

    const { primaries, groupByThreadKey } = groupWorkThreads([builder, manager, retry]);

    expect(primaries.map((item) => item.id)).toEqual(["pm-retry"]);
    const group = groupByThreadKey.get("local:pm-retry")!;
    expect(group.kind).toBe("request");
    expect(group.title).toBe("Triage open issues");
    expect(group.stages).toEqual([]);
    expect(group.children.map((entry) => entry.label)).toEqual(["Project manager", "Builder"]);
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

describe("workGroupInbox", () => {
  it("keeps rows that wait on you out of Working and above newer rows", () => {
    const request = (member: string) => ({ id: "triage", title: "Triage", member });
    const manager = inboxThread("pm", "2026-10-28T10:00:00.000Z", {
      crewRequest: request("Project manager"),
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
});

describe("workGroupOpenThread", () => {
  const stageOf = (
    id: string,
    createdAt: string,
    index: number,
    state: "done" | "approval" | "working",
    current: boolean,
  ) => ({
    ...inboxThread(id, createdAt),
    feature,
    crew: { featureId: "f1", stepId: id, index, total: 3, state, current },
  });

  it("opens the stage waiting on you, else the feature's lead", () => {
    const lead = { ...inboxThread("lead", "2026-10-28T09:00:00.000Z"), feature };
    const plan = stageOf("plan", "2026-10-28T10:00:00.000Z", 1, "done", false);
    const helper = {
      ...inboxThread("tester", "2026-10-28T11:00:00.000Z", {
        crewRequest: { id: "h", title: "Test it", member: "Tester" },
      }),
      feature,
    };
    const waiting = stageOf("build", "2026-10-28T12:00:00.000Z", 2, "approval", true);

    const group = workGroupOf(plan, [lead, plan, helper, waiting])!;
    expect(group.primary.id).toBe("build");
    expect(workGroupLead(group)?.id).toBe("lead");
    expect(workGroupOpenThread(group).id).toBe("build");

    const working = stageOf("build", "2026-10-28T12:00:00.000Z", 2, "working", true);
    expect(workGroupOpenThread(workGroupOf(working, [lead, plan, helper, working])!).id).toBe(
      "lead",
    );
  });
});

describe("workThreadLabel", () => {
  it("names a thread by its feature and stage, or its request and crew member", () => {
    expect(workThreadLabel(stage("build", "1", "qa_review", 3))).toBe(
      "Clip crop editing · QA review",
    );
    expect(
      workThreadLabel(
        thread("pm", "1", { crewRequest: { id: "r", title: "Triage", member: "Builder" } }),
      ),
    ).toBe("Triage · Builder");
    expect(workThreadLabel(thread("plain", "1"))).toBe("plain");
  });
});
