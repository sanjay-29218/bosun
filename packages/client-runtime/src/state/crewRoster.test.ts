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
const stage = (id: string, createdAt: string, stepId: string, index: number, current = false) =>
  thread(id, createdAt, {
    feature,
    crew: { stepId, index, total: 3, state: current ? "approval" : "done", current },
  });

describe("buildCrewRoster", () => {
  it("lists a feature's lead, its stages with their tries, then helpers", () => {
    const lead = thread("lead", "1", { feature, title: "Project manager" });
    const plan = stage("plan", "2", "plan", 1);
    const design1 = stage("design-1", "3", "design", 2);
    const design2 = stage("design-2", "4", "design", 2);
    const build = stage("build", "5", "build", 3, true);
    const tester = thread("tester", "6", {
      feature,
      crewRequest: { id: "h", title: "Test it", member: "Tester" },
    });
    const group = workGroupOf(build, [lead, plan, design1, design2, build, tester])!;

    expect(
      buildCrewRoster(group, null).map((entry) => [entry.kind, entry.name, entry.status]),
    ).toEqual([
      ["lead", "Project manager", "Idle"],
      ["stage", "Plan", "Done"],
      ["stage", "Design", "Done"],
      ["stage", "Build", "Approval"],
      ["helper", "Tester", "Idle"],
    ]);
    const design = buildCrewRoster(group, null).find((entry) => entry.name === "Design")!;
    expect(design.threadId).toBe("design-2");
    expect(design.tries).toEqual(["design-1"]);
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

    expect(buildCrewRoster(group, null).map((entry) => [entry.name, entry.status])).toEqual([
      ["Project manager", "Approval"],
      ["Project manager · earlier try", "Idle"],
      ["Builder", "Idle"],
    ]);
  });
});
