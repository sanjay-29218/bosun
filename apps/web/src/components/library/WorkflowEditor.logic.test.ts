import {
  PROJECT_MANAGER_ROLE_ID,
  ProviderInstanceId,
  type RoleConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addStageForRole,
  canRemoveStage,
  describeStageInputs,
  ensureWorkflowRole,
  pruneUnusedRoles,
  refreshWorkflowRoles,
  removeStage,
  renameStage,
  sameWorkflow,
  setRouteLimit,
  setStageOutcomes,
  stageIdFromName,
} from "./WorkflowEditor.logic";

function role(name: string, overrides: Partial<RoleConfig> = {}): RoleConfig {
  return {
    id: `role:${name}`,
    name: name.charAt(0).toUpperCase() + name.slice(1),
    instructions: "Do the work",
    allowedTools: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    enabled: true,
    autoCreateForFeature: true,
    revision: 1,
    ...overrides,
  };
}

function workflow(): WorkflowDefinition {
  const slot = (name: string) => ({
    roleId: `role:${name}`,
    roleRevision: 1,
    supervisor: "manager",
  });
  return {
    schemaVersion: 2,
    id: "feature-delivery",
    name: "Feature delivery",
    revision: 3,
    start: "plan",
    roles: {
      manager: { roleId: PROJECT_MANAGER_ROLE_ID, roleRevision: 1, supervisor: null },
      planner: slot("planner"),
      builder: slot("builder"),
      reviewer: slot("reviewer"),
    },
    steps: {
      review: {
        type: "task",
        role: "reviewer",
        task: "Review",
        next: { approved: "end", changes_requested: "build" },
        limits: { changes_requested: 3 },
        receives: { files: ["plan.md"], diffs: ["build"] },
      },
      build: { type: "task", role: "builder", task: "Build", next: { built: "review" } },
      plan: {
        type: "task",
        role: "planner",
        task: "Plan",
        next: { ready: "build" },
        gate: true,
        outputs: ["plan.md"],
      },
      orphan: { type: "task", role: "builder", task: "Unused", next: { done: "end" } },
      end: { type: "end" },
    },
    defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
  };
}

describe("describeStageInputs", () => {
  it("names picked files and diffs, and every earlier output by default", () => {
    const definition = workflow();
    expect(describeStageInputs(definition, "review")).toBe(
      "Gets plan.md, the Build changes and your notes",
    );
    expect(describeStageInputs(definition, "build")).toBe(
      "Gets every earlier output and your notes",
    );
  });
});

describe("refreshWorkflowRoles", () => {
  it("moves edited roles to their current revision and flags turned-off roles", () => {
    const result = refreshWorkflowRoles(workflow(), [
      role("planner", { revision: 4 }),
      role("builder", { enabled: false }),
      role("reviewer"),
    ]);
    expect(result.issues).toEqual([
      { slot: "planner", name: "Planner", reason: "changed" },
      { slot: "builder", name: "Builder", reason: "unavailable" },
    ]);
    expect(result.definition.roles.planner!.roleRevision).toBe(4);
  });

  it("returns the same definition when every role is current", () => {
    const definition = workflow();
    const result = refreshWorkflowRoles(definition, [
      role("planner"),
      role("builder"),
      role("reviewer"),
    ]);
    expect(result.definition).toBe(definition);
    expect(result.issues).toEqual([]);
  });
});

describe("stage edits", () => {
  it("keeps a stage while anything starts at or routes to it", () => {
    const definition = workflow();
    expect(canRemoveStage(definition, "plan")).toBe(false);
    expect(canRemoveStage(definition, "build")).toBe(false);
    expect(canRemoveStage(definition, "orphan")).toBe(true);
  });

  it("drops a removed stage's outputs from later stages' picks", () => {
    const definition = removeStage(setStageOutcomes(workflow(), "plan", ["ready"]), "plan");
    const review = definition.steps.review;
    expect(review?.type === "task" && review.receives).toEqual({ files: [], diffs: ["build"] });
  });

  it("keeps routes and limits for kept outcomes and routes new ones to the end", () => {
    const definition = setStageOutcomes(workflow(), "review", ["changes_requested", "blocked"]);
    const review = definition.steps.review;
    expect(review?.type === "task" && review.next).toEqual({
      changes_requested: "build",
      blocked: "end",
    });
    expect(review?.type === "task" && review.limits).toEqual({ changes_requested: 3 });
    const unlimited = setRouteLimit(definition, "review", "changes_requested", null).steps.review;
    expect(unlimited?.type === "task" && "limits" in unlimited).toBe(false);
  });

  it("adds a role under the Manager and prunes roles no stage uses", () => {
    const { definition, slot } = ensureWorkflowRole(workflow(), role("designer"));
    expect(slot).toBe("designer");
    expect(definition.roles.designer?.supervisor).toBe("manager");
    // The Manager stays: other roles answer to it.
    expect(Object.keys(pruneUnusedRoles(definition).roles)).toEqual([
      "manager",
      "planner",
      "builder",
      "reviewer",
    ]);
  });
});

describe("renameStage", () => {
  it("moves the stage and every reference to it under the new id", () => {
    const definition = renameStage(
      { ...workflow(), layout: { build: { x: 1, y: 2 } } },
      "build",
      "implement",
    );
    expect(Object.keys(definition.steps)).not.toContain("build");
    expect(definition.steps.implement).toMatchObject({ task: "Build", next: { built: "review" } });
    expect(definition.steps.plan?.type === "task" && definition.steps.plan.next).toEqual({
      ready: "implement",
    });
    const review = definition.steps.review;
    expect(review?.type === "task" && review.next.changes_requested).toBe("implement");
    expect(review?.type === "task" && review.receives?.diffs).toEqual(["implement"]);
    expect(definition.layout).toEqual({ implement: { x: 1, y: 2 } });
  });

  it("moves the first stage too", () => {
    expect(renameStage(workflow(), "plan", "scope").start).toBe("scope");
  });
});

describe("stageIdFromName", () => {
  it("reads like the starter ids and stays unique", () => {
    expect(stageIdFromName("Security review", [])).toBe("security_review");
    expect(stageIdFromName("QA", [])).toBe("qa");
    expect(stageIdFromName("Build", ["build"])).toBe("build_2");
    expect(stageIdFromName("2nd pass", [])).toBe("stage_2nd_pass");
  });
});

describe("ensureWorkflowRole", () => {
  it("keeps generated slot ids within the server's 80 characters, suffix included", () => {
    const long = role("planner", { id: "role:long", name: "Very long role ".repeat(10) });
    const first = ensureWorkflowRole(workflow(), long);
    const second = ensureWorkflowRole(first.definition, { ...long, id: "role:long-2" });
    expect(first.slot.length).toBeLessThanOrEqual(80);
    expect(second.slot).toBe(`${first.slot}-2`);
    expect(second.slot.length).toBeLessThanOrEqual(80);
  });
});

describe("sameWorkflow", () => {
  it("ignores key order", () => {
    expect(sameWorkflow({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameWorkflow({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});

describe("addStageForRole", () => {
  it("drops a stage run by the role where it lands, routing done to Finish", () => {
    const first = addStageForRole(workflow(), role("designer"), { x: 120, y: -40 });
    expect(first.stepId).toBe("designer");
    expect(first.definition.steps.designer).toEqual({
      type: "task",
      role: "designer",
      task: "",
      next: { done: "end" },
    });
    expect(first.definition.layout?.designer).toEqual({ x: 120, y: -40 });
    expect(first.definition.roles.designer?.roleId).toBe("role:designer");

    // A second drop of the same role reuses its slot and takes the next free stage id.
    const second = addStageForRole(first.definition, role("designer"), { x: 0, y: 0 });
    expect(second.stepId).toBe("designer-2");
    expect(second.definition.steps["designer-2"]).toMatchObject({ role: "designer" });
    expect(
      Object.keys(second.definition.roles).filter((slot) => slot.startsWith("designer")),
    ).toEqual(["designer"]);
  });
});
