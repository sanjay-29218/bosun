import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { validateWorkflowDefinition } from "./WorkflowGraph.ts";
import { makeStarterWorkflow } from "./starterWorkflow.ts";

describe("starter workflow", () => {
  it("uses a configurable five-bot sequence with a reviewer decision", () => {
    const projectId = ProjectId.make("project-one");
    const definition = makeStarterWorkflow(projectId);
    expect(validateWorkflowDefinition(definition).map((step) => step.id)).toEqual([
      "plan",
      "design",
      "build",
      "qa",
      "review",
      "end",
    ]);
    expect(definition.steps.find((step) => step.id === "review")).toEqual({
      id: "review",
      kind: "decision",
      approver: { kind: "bot", templateId: `template:reviewer:${projectId}` },
      dependsOn: ["qa"],
    });
    expect(definition.steps.some((step) => step.id === "manager")).toBe(false);
  });
});
