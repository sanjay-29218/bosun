import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCrewRoster, crewThreadStatus, type CrewRosterThread } from "./crewRoster.ts";
import { workGroupOf } from "./workGroups.ts";

const feature = { id: "f1", title: "Clip crop editing" };
const thread = (
  id: string,
  createdAt: string,
  fields: Partial<Omit<CrewRosterThread, "id" | "createdAt">> = {},
): CrewRosterThread => ({
  id: ThreadId.make(id),
  environmentId: "local",
  title: id,
  createdAt,
  updatedAt: createdAt,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  runtime: null,
  latestRun: null,
  ...fields,
});
const member = (id: string, createdAt: string, name: string, fields = {}) =>
  thread(id, createdAt, { feature: { ...feature, member: name }, ...fields });

const runtime = (status: string) => ({ status }) as CrewRosterThread["runtime"];
const run = (status: string) => ({ status }) as CrewRosterThread["latestRun"];

describe("buildCrewRoster", () => {
  it("lists a feature's lead, then the members it handed work to, numbering repeats", () => {
    // A finished turn: the member's part is done, and the lead stopped with the feature unfinished.
    const finished = { latestRun: { status: "completed" } as CrewRosterThread["latestRun"] };
    const lead = thread("lead", "1", { feature, title: "Feature manager", ...finished });
    const plan = member("plan", "2", "Planner", finished);
    const replan = member("replan", "3", "Planner", { hasPendingUserInput: true });
    const build = member("build", "4", "Builder");
    const group = workGroupOf(build, [lead, plan, replan, build])!;

    expect(group.primary).toBe(lead);
    expect(buildCrewRoster(group).map((entry) => [entry.kind, entry.name, entry.status])).toEqual([
      ["lead", "Feature manager", "Waiting"],
      ["member", "Planner", "Done"],
      ["member", "Planner · try 2", "Needs input"],
      ["member", "Builder", "Waiting"],
    ]);
  });

  it("leads a bot request with its first role's latest try", () => {
    const request = (member: string) => ({ id: "triage", title: "Triage", member });
    const first = thread("pm", "1", { crewRequest: request("Feature manager") });
    const builder = thread("builder", "2", { crewRequest: request("Builder") });
    const retry = thread("pm-retry", "3", {
      crewRequest: request("Feature manager"),
      hasPendingApprovals: true,
    });
    const group = workGroupOf(first, [first, builder, retry])!;

    expect(buildCrewRoster(group).map((entry) => [entry.name, entry.status])).toEqual([
      ["Feature manager", "Needs input"],
      ["Feature manager · earlier try", "Waiting"],
      ["Builder", "Waiting"],
    ]);
  });

  it.each([
    ["a pending approval", { hasPendingApprovals: true }, "needs-input", "needs-input"],
    ["a pending question", { hasPendingUserInput: true }, "needs-input", "needs-input"],
    ["a member's approval", { pendingSubagentRequest: "approval" }, "needs-input", "needs-input"],
    ["a member's question", { pendingSubagentRequest: "user_input" }, "needs-input", "needs-input"],
    ["a running turn", { runtime: runtime("running") }, "working", "working"],
    ["a failed runtime", { runtime: runtime("failed") }, "failed", "failed"],
    ["a failed run", { latestRun: run("failed") }, "failed", "failed"],
    ["a finished turn", { latestRun: run("completed") }, "waiting", "done"],
    ["an idle thread", { runtime: runtime("idle") }, "waiting", "waiting"],
    ["a thread that never ran", {}, "waiting", "waiting"],
  ] as const)("reads %s as %s for a lead and %s for a member", (_, fields, lead, member) => {
    const subject = thread("t", "1", fields as Partial<CrewRosterThread>);
    expect([crewThreadStatus(subject, "lead"), crewThreadStatus(subject, "member")]).toEqual([
      lead,
      member,
    ]);
  });
});
