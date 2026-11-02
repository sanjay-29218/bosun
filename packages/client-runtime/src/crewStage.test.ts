import {
  ProjectId,
  ThreadId,
  type WorkflowFeatureSnapshot,
  type WorkflowStepSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  featureStageRows,
  formatCrewStageLine,
  formatStageName,
  isHiddenStageThread,
  workflowStageOverview,
  workflowSummaryLine,
} from "./crewStage.ts";

const step = (
  id: string,
  status: WorkflowStepSnapshot["status"],
  threadId: string | null = null,
): WorkflowStepSnapshot => ({
  id,
  status,
  executionId: status === "pending" ? null : `${id}-execution`,
  attempt: status === "pending" ? 0 : 1,
  runId: threadId === null ? null : `${id}-run`,
  threadId: threadId === null ? null : ThreadId.make(threadId),
  outcome: null,
});

const snapshot = (
  steps: ReadonlyArray<WorkflowStepSnapshot>,
  overrides: Partial<WorkflowFeatureSnapshot> = {},
): WorkflowFeatureSnapshot => ({
  featureId: "feature",
  projectId: ProjectId.make("project"),
  definition: {
    schemaVersion: 2,
    id: "delivery",
    name: "Delivery",
    revision: 3,
    start: "plan",
    roles: {},
    steps: {
      plan: { type: "task", role: "planner", task: "Plan", next: { ready: "design" }, gate: true },
      design: { type: "task", role: "designer", task: "Design", next: { ready: "qa_check" } },
      qa_check: {
        type: "task",
        role: "qa_tester",
        task: "Test",
        next: { passed: "end", failed: "design" },
      },
      end: { type: "end" },
    },
    defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 10 },
  },
  eventVersion: 1,
  createdAt: "2026-10-09T10:00:00.000Z",
  steps,
  activeStepId: steps.find((item) => item.status !== "completed")?.id ?? null,
  readyStepIds: [],
  executionCount: 1,
  completed: false,
  cancelled: false,
  paused: false,
  state: "working",
  historyLength: 0,
  recentEvents: [],
  ...overrides,
});

describe("stage formatting", () => {
  it("names stages from their step ids", () => {
    expect(formatStageName("change_review")).toBe("Change review");
    expect(formatStageName("qa")).toBe("QA");
    expect(formatStageName("build-web")).toBe("Build web");
    expect(formatCrewStageLine({ stepId: "design", index: 2, total: 6 })).toBe("Design · 2/6");
  });

  it("hides only stage threads that are no longer the feature's current one", () => {
    expect(isHiddenStageThread({ crew: null })).toBe(false);
    expect(isHiddenStageThread({})).toBe(false);
    expect(isHiddenStageThread({ crew: { current: true } })).toBe(false);
    expect(isHiddenStageThread({ crew: { current: false } })).toBe(true);
  });
});

describe("workflowSummaryLine", () => {
  it("follows the first route from the start and marks gates", () => {
    expect(workflowSummaryLine(snapshot([]).definition)).toBe("Plan → approve → Design → QA check");
  });
});

describe("workflowStageOverview", () => {
  it("lists every stage with its role, gate and where each outcome routes", () => {
    const definition = snapshot([]).definition;
    expect(
      workflowStageOverview({
        ...definition,
        steps: {
          ...definition.steps,
          qa_check: {
            type: "task",
            role: "qa_tester",
            task: "Test",
            next: { passed: "end", failed: "design" },
            limits: { failed: 2 },
          },
        },
      }),
    ).toEqual([
      { stepId: "plan", name: "Plan", role: "Planner", gate: true, routes: ["ready → Design"] },
      {
        stepId: "design",
        name: "Design",
        role: "Designer",
        gate: false,
        routes: ["ready → QA check"],
      },
      {
        stepId: "qa_check",
        name: "QA check",
        role: "QA tester",
        gate: false,
        routes: ["passed → Done", "failed → Design (up to 2×)"],
      },
    ]);
  });
});

describe("featureStageRows", () => {
  it("lists task stages in workflow order", () => {
    const failed = snapshot([
      step("plan", "completed", "t-plan"),
      step("design", "failed", "t-design"),
    ]);
    expect(featureStageRows(failed).map((row) => [row.name, row.status, row.active])).toEqual([
      ["Plan", "completed", false],
      ["Design", "failed", true],
      ["QA check", "pending", false],
    ]);
  });
});
