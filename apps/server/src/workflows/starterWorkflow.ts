import type { ProjectId, WorkflowDefinition } from "@t3tools/contracts";

export const STARTER_WORKFLOW_ID = "feature-delivery";

/** A configurable starting point, with supervision separate from step order. */
export const makeStarterWorkflow = (
  projectId: ProjectId,
  templateRevisions: Readonly<Record<string, number>> = {},
): WorkflowDefinition => {
  const template = (role: string) => ({
    template: {
      kind: "template" as const,
      id: `template:${role}:${projectId}`,
      revision: templateRevisions[role] ?? 1,
    },
    supervisor: "manager",
  });
  return {
    schemaVersion: 1,
    id: STARTER_WORKFLOW_ID,
    name: "Feature delivery",
    revision: 1,
    start: "plan",
    bots: {
      manager: {
        template: { kind: "existing-project-bot", id: `bot-manager:${projectId}` },
        supervisor: null,
      },
      planner: template("planner"),
      designer: template("designer"),
      builder: template("builder"),
      qa: template("qa-tester"),
      reviewer: template("reviewer"),
    },
    steps: {
      plan: {
        type: "task",
        bot: "planner",
        task: "Plan the feature",
        next: { ready: "design" },
        gate: true,
      },
      design: {
        type: "task",
        bot: "designer",
        task: "Design the feature",
        next: { ready: "build" },
        gate: true,
      },
      build: {
        type: "task",
        bot: "builder",
        task: "Build the feature",
        next: { built: "qa", design_change_requested: "change_review" },
      },
      qa: {
        type: "task",
        bot: "qa",
        task: "Test the feature",
        next: { passed: "review", changes_requested: "change_review" },
      },
      review: {
        type: "task",
        bot: "reviewer",
        task: "Review the feature",
        next: { approved: "end", changes_requested: "change_review" },
        limits: { changes_requested: 3 },
      },
      change_review: {
        type: "task",
        bot: "manager",
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
