import { PROJECT_MANAGER_ROLE_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { validateWorkflowDefinition } from "./WorkflowGraph.ts";
import { makeStarterWorkflow } from "./starterWorkflow.ts";

describe("starter workflow", () => {
  it("has independently editable assignments, supervisors, and routes", () => {
    const definition = makeStarterWorkflow({ "role:builder": 4 });
    expect(() => validateWorkflowDefinition(definition)).not.toThrow();
    expect(definition.roles.builder).toEqual({
      roleId: "role:builder",
      roleRevision: 4,
      supervisor: "manager",
    });
    expect(definition.roles.manager).toMatchObject({
      roleId: PROJECT_MANAGER_ROLE_ID,
      supervisor: null,
    });
    expect(definition.steps.qa).toMatchObject({
      next: { passed: "review", changes_requested: "change_review" },
      outputs: ["qa-report.md"],
    });
    expect(definition.steps.plan).toMatchObject({ outputs: ["plan.md"] });
    expect(definition.steps.design).toMatchObject({ outputs: ["design.md"] });
    expect(definition.steps.review).toMatchObject({
      next: { approved: "end", changes_requested: "change_review" },
    });
    expect(definition.steps.build).toMatchObject({
      next: { built: "qa", design_change_requested: "change_review" },
    });
    expect(definition.steps.change_review).toMatchObject({
      role: "manager",
      next: { revise_design: "design", revise_build: "build" },
    });
  });
});
