import {
  ProjectId,
  ThreadId,
  type FeatureCardState,
  type WorkflowDefinition,
  type WorkflowFeatureSnapshot,
  type WorkflowStepSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  crewCurrentThreadId,
  crewGateCopy,
  crewOpenQuestion,
  crewSendBackTargets,
} from "./crew.ts";

const projectId = ProjectId.make("project");

const definition: WorkflowDefinition = {
  schemaVersion: 2,
  id: "feature-delivery",
  name: "Feature delivery",
  revision: 1,
  start: "plan",
  roles: {},
  steps: {
    plan: { type: "task", role: "planner", task: "Plan", next: { ready: "design" }, gate: true },
    design: {
      type: "task",
      role: "designer",
      task: "Design",
      next: { ready: "build" },
      gate: true,
      outputs: ["design.md"],
    },
    build: { type: "task", role: "builder", task: "Build", next: { built: "end" } },
    end: { type: "end" },
  },
  defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
};

const step = (
  id: string,
  status: WorkflowStepSnapshot["status"],
  threadId: string | null,
  extra: Partial<WorkflowStepSnapshot> = {},
): WorkflowStepSnapshot => ({
  id,
  status,
  executionId: threadId === null ? null : `exec-${id}`,
  attempt: 1,
  runId: null,
  threadId: threadId === null ? null : ThreadId.make(threadId),
  outcome: null,
  ...extra,
});

const feature = (input: {
  readonly id: string;
  readonly state: FeatureCardState;
  readonly stage: string | null;
  readonly steps: ReadonlyArray<WorkflowStepSnapshot>;
  readonly since?: string;
}): WorkflowFeatureSnapshot => {
  const index = input.stage === null ? -1 : ["plan", "design", "build"].indexOf(input.stage);
  const snapshot: WorkflowFeatureSnapshot = {
    featureId: input.id,
    projectId,
    definition,
    eventVersion: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    steps: input.steps,
    activeStepId: input.stage,
    readyStepIds: [],
    executionCount: 1,
    completed: input.state === "done",
    cancelled: input.state === "cancelled",
    state: input.state,
    stage: input.stage === null ? null : { stepId: input.stage, index: index + 1, total: 3 },
    historyLength: 1,
    recentEvents: [
      {
        id: `${input.id}-event`,
        stepId: input.stage ?? "build",
        executionId: null,
        kind: "started",
        runId: null,
        outcome: null,
        sourceKind: null,
        sourceId: null,
        actorId: "workflow",
        detail: null,
        occurredAt: input.since ?? "2026-10-01T00:00:00.000Z",
      },
    ],
    outputs: [
      {
        kind: "file",
        path: "design.md",
        stepId: "design",
        version: 2,
        threadId: null,
      },
    ],
  };
  return snapshot;
};

const atDesign = feature({
  id: "kanban",
  state: "approval",
  stage: "design",
  steps: [
    step("plan", "completed", "thread-plan"),
    step("design", "awaiting-approval", "thread-design", { pendingOutcome: "ready" }),
    step("build", "pending", null),
  ],
  since: "2026-10-02T00:00:00.000Z",
});

describe("crew current thread", () => {
  it("is the current stage's thread while a stage runs", () => {
    expect(crewCurrentThreadId(atDesign)).toBe("thread-design");
  });

  it("opens the last stage that ran once a feature is done", () => {
    const done = feature({
      id: "done",
      state: "done",
      stage: null,
      steps: [
        step("plan", "completed", "thread-plan"),
        step("design", "completed", "thread-design"),
        step("build", "completed", "thread-build"),
      ],
    });
    expect(crewCurrentThreadId(done)).toBe("thread-build");
  });
});

describe("crew questions", () => {
  it("returns the question the current stage is waiting on, and nothing once it moved on", () => {
    const asking = feature({
      id: "asking",
      state: "input",
      stage: "plan",
      steps: [step("plan", "needs-input", "t-plan")],
    });
    const snapshot = {
      ...asking,
      recentEvents: [
        {
          ...asking.recentEvents[0]!,
          kind: "question" as const,
          stepId: "plan",
          executionId: "exec-plan",
          detail: "Drag between columns, or buttons only?",
        },
      ],
    };
    expect(crewOpenQuestion(snapshot)).toBe("Drag between columns, or buttons only?");
    expect(crewOpenQuestion(atDesign)).toBeNull();
  });
});

describe("crew gate wording", () => {
  it("names the artifact, what approving starts, and who reads the note", () => {
    expect(crewGateCopy(atDesign)).toEqual({
      stepId: "design",
      kicker: "Design approval",
      title: "design.md v2",
      consequence: "Approving starts Build with the Builder.",
      noteRecipient: "Builder",
    });
  });

  it("offers only stages that already ran as send-back targets, nearest first", () => {
    const building = feature({
      id: "build",
      state: "failed",
      stage: "build",
      steps: [
        step("plan", "completed", "t1"),
        step("design", "completed", "t2"),
        step("build", "failed", "t3"),
      ],
    });
    expect(crewSendBackTargets(building, "build").map((t) => t.stepId)).toEqual(["design", "plan"]);
    expect(crewSendBackTargets(atDesign, "plan")).toEqual([]);
  });
});
