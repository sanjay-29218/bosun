import { PROJECT_MANAGER_ROLE_ID, type WorkflowDefinition } from "@t3tools/contracts";

export const STARTER_WORKFLOW_ID = "feature-delivery";
export const AUTO_WORKFLOW_ID = "feature-delivery-auto";

/**
 * A configurable starting point, with supervision separate from step order. `roleRevisions`
 * pins each global role at its current revision.
 */
export const makeStarterWorkflow = (
  roleRevisions: Readonly<Record<string, number>> = {},
): WorkflowDefinition => {
  const role = (roleId: string) => ({
    roleId,
    roleRevision: roleRevisions[roleId] ?? 1,
    supervisor: "manager",
  });
  return {
    schemaVersion: 2,
    id: STARTER_WORKFLOW_ID,
    name: "Feature delivery",
    revision: 1,
    start: "plan",
    roles: {
      manager: {
        roleId: PROJECT_MANAGER_ROLE_ID,
        roleRevision: roleRevisions[PROJECT_MANAGER_ROLE_ID] ?? 1,
        supervisor: null,
      },
      planner: role("role:planner"),
      designer: role("role:designer"),
      builder: role("role:builder"),
      qa: role("role:qa-tester"),
    },
    steps: {
      plan: {
        type: "task",
        role: "planner",
        task: "Plan the feature",
        next: { ready: "design" },
        gate: true,
        outputs: ["plan.md"],
      },
      design: {
        type: "task",
        role: "designer",
        task: "Design the feature",
        next: { ready: "build" },
        gate: true,
        outputs: ["design.md"],
      },
      build: {
        type: "task",
        role: "builder",
        task: "Build the feature",
        next: { built: "qa", design_change_requested: "design" },
      },
      qa: {
        type: "task",
        role: "qa",
        task: "Test the feature",
        next: { passed: "end", changes_requested: "build" },
        limits: { changes_requested: 2 },
        outputs: ["qa-report.md"],
      },
      end: { type: "end" },
    },
    defaults: {
      questions: "supervisor",
      failure: "pause",
      maxStepExecutions: 30,
    },
  };
};

/** Feature delivery with the lead approving gates and answering stage questions. */
export const makeAutoWorkflow = (
  roleRevisions: Readonly<Record<string, number>> = {},
): WorkflowDefinition => {
  const starter = makeStarterWorkflow(roleRevisions);
  return {
    ...starter,
    id: AUTO_WORKFLOW_ID,
    name: "Feature delivery (auto)",
    defaults: { ...starter.defaults, decisions: "lead" },
  };
};
