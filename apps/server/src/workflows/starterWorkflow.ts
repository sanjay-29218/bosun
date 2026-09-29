import type { ProjectId, WorkflowDefinition, WorkflowStep } from "@t3tools/contracts";

export const STARTER_WORKFLOW_ID = "feature-delivery";

/** Example project definition; the engine treats its template IDs like any others. */
export const makeStarterWorkflow = (projectId: ProjectId): WorkflowDefinition => {
  const step = (id: string, template: string, dependsOn: ReadonlyArray<string>): WorkflowStep => ({
    id,
    kind: "bot",
    templateId: `template:${template}:${projectId}`,
    completion: "handoff",
    dependsOn,
  });
  return {
    id: STARTER_WORKFLOW_ID,
    name: "Feature delivery",
    revision: 1,
    steps: [
      step("plan", "planner", []),
      step("design", "designer", ["plan"]),
      step("build", "builder", ["design"]),
      step("qa", "qa-tester", ["build"]),
      {
        id: "review",
        kind: "decision",
        approver: { kind: "bot", templateId: `template:reviewer:${projectId}` },
        dependsOn: ["qa"],
      },
      { id: "end", kind: "end", dependsOn: ["review"] },
    ],
  };
};
