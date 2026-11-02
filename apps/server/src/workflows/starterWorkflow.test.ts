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
    expect(Object.keys(definition.steps)).toEqual(["plan", "design", "build", "qa", "end"]);
    expect(definition.steps.plan).toMatchObject({ gate: true, outputs: ["plan.md"] });
    expect(definition.steps.design).toMatchObject({ gate: true, outputs: ["design.md"] });
    expect(definition.steps.build).toMatchObject({
      next: { built: "qa", design_change_requested: "design" },
    });
    expect(definition.steps.qa).toMatchObject({
      next: { passed: "end", changes_requested: "build" },
      limits: { changes_requested: 2 },
      outputs: ["qa-report.md"],
    });
  });
});
