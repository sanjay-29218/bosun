import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildCrewRoster, type CrewRosterThread } from "./crewRoster.ts";
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

describe("buildCrewRoster", () => {
  it("lists a feature's lead, then the members it handed work to, numbering repeats", () => {
    // A finished turn: the member's part is done, and the lead has handed back to you.
    const finished = { latestRun: { status: "completed" } as CrewRosterThread["latestRun"] };
    const lead = thread("lead", "1", { feature, title: "Project manager", ...finished });
    const plan = member("plan", "2", "Planner", finished);
    const replan = member("replan", "3", "Planner", { hasPendingUserInput: true });
    const build = member("build", "4", "Builder");
    const group = workGroupOf(build, [lead, plan, replan, build])!;

    expect(group.primary).toBe(lead);
    expect(buildCrewRoster(group).map((entry) => [entry.kind, entry.name, entry.status])).toEqual([
      ["lead", "Project manager", "Your turn"],
      ["member", "Planner", "Done"],
      ["member", "Planner · try 2", "Input"],
      ["member", "Builder", "Idle"],
    ]);
  });

  it("leads a bot request with its first role's latest try", () => {
    const request = (member: string) => ({ id: "triage", title: "Triage", member });
    const first = thread("pm", "1", { crewRequest: request("Project manager") });
    const builder = thread("builder", "2", { crewRequest: request("Builder") });
    const retry = thread("pm-retry", "3", {
      crewRequest: request("Project manager"),
      hasPendingApprovals: true,
    });
    const group = workGroupOf(first, [first, builder, retry])!;

    expect(buildCrewRoster(group).map((entry) => [entry.name, entry.status])).toEqual([
      ["Project manager", "Approval"],
      ["Project manager · earlier try", "Idle"],
      ["Builder", "Idle"],
    ]);
  });
});
