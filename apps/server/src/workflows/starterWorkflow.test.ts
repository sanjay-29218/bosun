import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { validateWorkflowDefinition } from "./WorkflowGraph.ts";
import { makeStarterWorkflow } from "./starterWorkflow.ts";

describe("starter workflow", () => {
  it("has independently editable assignments, supervisors, and routes", () => {
    const projectId = ProjectId.make("project-one");
    const definition = makeStarterWorkflow(projectId, { builder: 4 });
    expect(() => validateWorkflowDefinition(definition)).not.toThrow();
    expect(definition.bots.builder).toEqual({
      template: { kind: "template", id: `template:builder:${projectId}`, revision: 4 },
      supervisor: "manager",
    });
    expect(definition.steps.qa).toMatchObject({
      next: { passed: "review", changes_requested: "build" },
    });
    expect(definition.steps.review).toMatchObject({
      next: { approved: "end", changes_requested: "build" },
    });
  });
});
