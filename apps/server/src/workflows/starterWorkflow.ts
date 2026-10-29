import { PROJECT_MANAGER_ROLE_ID, type WorkflowDefinition } from "@t3tools/contracts";

export const STARTER_WORKFLOW_ID = "feature-delivery";

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
      reviewer: role("role:reviewer"),
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
        next: { built: "qa", design_change_requested: "change_review" },
      },
      qa: {
        type: "task",
        role: "qa",
        task: "Test the feature",
        next: { passed: "review", changes_requested: "change_review" },
        outputs: ["qa-report.md"],
      },
      review: {
        type: "task",
        role: "reviewer",
        task: "Review the feature",
        next: { approved: "end", changes_requested: "change_review" },
        limits: { changes_requested: 3 },
      },
      change_review: {
        type: "task",
        role: "manager",
        task: "Decide how to handle the requested change",
        next: { revise_design: "design", revise_build: "build" },
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

export const QUICK_TASK_WORKFLOW_ID = "quick-task";

/**
 * What a bot's request to a project runs on: one stage, where the project manager does the
 * work or hands the coding to the project's builder.
 */
export const makeQuickTaskWorkflow = (
  roleRevisions: Readonly<Record<string, number>> = {},
): WorkflowDefinition => ({
  schemaVersion: 2,
  id: QUICK_TASK_WORKFLOW_ID,
  name: "Quick task",
  revision: 1,
  start: "handle",
  roles: {
    manager: {
      roleId: PROJECT_MANAGER_ROLE_ID,
      roleRevision: roleRevisions[PROJECT_MANAGER_ROLE_ID] ?? 1,
      supervisor: null,
    },
  },
  steps: {
    handle: {
      type: "task",
      role: "manager",
      task: "Handle the request: do it yourself, or hand the coding to the project's builder with crew_delegate and report what it did. If it needs planning or design first, move it to a bigger workflow with crew_switch_workflow",
      next: { done: "end" },
    },
    end: { type: "end" },
  },
  defaults: {
    questions: "supervisor",
    failure: "pause",
    maxStepExecutions: 30,
  },
});
