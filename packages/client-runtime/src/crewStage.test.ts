import {
  ProjectId,
  ThreadId,
  type WorkflowFeatureSnapshot,
  type WorkflowStepSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  availableCrewActions,
  crewStagePrompt,
  featureStageRows,
  formatCrewStageLine,
  formatStageName,
  isHiddenStageThread,
  sendBackTargets,
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
  botRunId: threadId === null ? null : `${id}-run`,
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
    schemaVersion: 1,
    id: "delivery",
    name: "Delivery",
    revision: 3,
    start: "plan",
    bots: {},
    steps: {
      plan: { type: "task", bot: "planner", task: "Plan", next: { ready: "design" }, gate: true },
      design: { type: "task", bot: "designer", task: "Design", next: { ready: "qa_check" } },
      qa_check: {
        type: "task",
        bot: "qa_tester",
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

describe("crew actions", () => {
  it("offers gate decisions only while a stage awaits approval", () => {
    const gate = snapshot([step("plan", "awaiting-approval", "t-plan")], { state: "approval" });
    expect(availableCrewActions(gate)).toEqual([
      "approve",
      "request-changes",
      "take-over",
      "pause",
      "cancel",
    ]);
  });

  it("offers recovery for a failed stage, with send back only to finished stages", () => {
    const failed = snapshot([
      step("plan", "completed", "t-plan"),
      step("design", "failed", "t-design"),
    ]);
    expect(sendBackTargets(failed)).toEqual(["plan"]);
    expect(availableCrewActions(failed)).toEqual([
      "retry",
      "take-over",
      "send-back",
      "skip",
      "pause",
      "cancel",
    ]);
    const first = snapshot([step("plan", "failed", "t-plan")]);
    expect(availableCrewActions(first)).not.toContain("send-back");
  });

  it("hands a taken-over stage on with Mark done, and a paused feature back with Resume", () => {
    const takenOver = snapshot([step("plan", "taken-over", "t-plan")], { paused: true });
    expect(availableCrewActions(takenOver)).toEqual(["retry", "mark-done", "resume", "cancel"]);
  });

  it("only reopens a finished or cancelled feature", () => {
    expect(availableCrewActions(snapshot([], { completed: true, activeStepId: null }))).toEqual([
      "reopen",
    ]);
    expect(availableCrewActions(snapshot([], { cancelled: true }))).toEqual(["reopen"]);
  });

  it("lets a queued feature start now", () => {
    const queued = snapshot([step("plan", "pending")], { state: "queued" });
    expect(availableCrewActions(queued)).toContain("start-now");
  });
});

describe("crewStagePrompt", () => {
  const failed = snapshot(
    [step("plan", "completed", "t-plan"), step("design", "failed", "t-design")],
    {
      recentEvents: [
        {
          id: "e1",
          stepId: "design",
          executionId: "design-execution",
          kind: "failed",
          botRunId: "design-run",
          outcome: null,
          sourceKind: "workflow",
          sourceId: "x",
          actorId: "workflow",
          detail: "Typecheck failed",
          occurredAt: "2026-10-09T10:00:00.000Z",
        },
      ],
    },
  );

  it("shows the failure banner in the failed stage's thread only", () => {
    expect(crewStagePrompt(failed, ThreadId.make("t-design"))).toEqual({
      kind: "failure",
      stepId: "design",
      attempt: 1,
      error: "Typecheck failed",
    });
    expect(crewStagePrompt(failed, ThreadId.make("t-plan"))).toBeNull();
  });

  it("lists the outcomes a person can mark a taken-over stage done with", () => {
    const takenOver = snapshot([
      step("plan", "completed", "t-plan"),
      step("design", "completed", "t-design"),
      step("qa_check", "taken-over", "t-qa"),
    ]);
    expect(crewStagePrompt(takenOver, ThreadId.make("t-qa"))).toEqual({
      kind: "taken-over",
      stepId: "qa_check",
      outcomes: ["passed", "failed"],
    });
  });

  it("lists task stages in workflow order", () => {
    expect(featureStageRows(failed).map((row) => [row.name, row.status, row.active])).toEqual([
      ["Plan", "completed", false],
      ["Design", "failed", true],
      ["QA check", "pending", false],
    ]);
  });
});
