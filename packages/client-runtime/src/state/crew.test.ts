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
  crewGroupByPhase,
  crewGroupByStage,
  crewNeedsYou,
  crewOpenQuestion,
  crewSendBackTargets,
  crewStageLine,
  crewStageThreads,
  type CrewFeature,
} from "./crew.ts";

const projectId = ProjectId.make("project");

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "feature-delivery",
  name: "Feature delivery",
  revision: 1,
  start: "plan",
  bots: {},
  steps: {
    plan: { type: "task", bot: "planner", task: "Plan", next: { ready: "design" }, gate: true },
    design: {
      type: "task",
      bot: "designer",
      task: "Design",
      next: { ready: "build" },
      gate: true,
      outputs: ["design.md"],
    },
    build: { type: "task", bot: "builder", task: "Build", next: { built: "end" } },
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
  botRunId: null,
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
  readonly workflowId?: string;
}): CrewFeature => {
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
        botRunId: null,
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
  return {
    record: {
      id: input.id,
      projectId,
      title: input.id,
      brief: "",
      workflowId: input.workflowId ?? definition.id,
      workflowRevision: 1,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: input.since ?? "2026-10-01T00:00:00.000Z",
      status: input.state === "done" || input.state === "cancelled" ? "closed" : "open",
      botAssignments: {},
    },
    snapshot,
  };
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

describe("crew stage threads", () => {
  it("summarizes every stage thread and marks only the current one", () => {
    const threads = crewStageThreads(atDesign);
    expect(threads.map((thread) => [thread.threadId, thread.summary.current])).toEqual([
      ["thread-plan", false],
      ["thread-design", true],
    ]);
    expect(crewStageLine(definition, threads[1]!.summary)).toBe("Design · 2/3 · Designer");
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
      ...asking.snapshot!,
      recentEvents: [
        {
          ...asking.snapshot!.recentEvents[0]!,
          kind: "question" as const,
          stepId: "plan",
          executionId: "exec-plan",
          detail: "Drag between columns, or buttons only?",
        },
      ],
    };
    expect(crewOpenQuestion(snapshot)).toBe("Drag between columns, or buttons only?");
    expect(crewOpenQuestion(atDesign.snapshot!)).toBeNull();
  });
});

describe("crew gate wording", () => {
  it("names the artifact, what approving starts, and who reads the note", () => {
    expect(crewGateCopy(atDesign.snapshot!)).toEqual({
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
    expect(crewSendBackTargets(building.snapshot!, "build").map((t) => t.stepId)).toEqual([
      "design",
      "plan",
    ]);
    expect(crewSendBackTargets(atDesign.snapshot!, "plan")).toEqual([]);
  });
});

describe("crew grouping", () => {
  const failed = feature({
    id: "failed",
    state: "failed",
    stage: "build",
    steps: [step("build", "failed", "t-failed")],
    since: "2026-10-01T00:00:00.000Z",
  });
  const working = feature({
    id: "working",
    state: "working",
    stage: "build",
    steps: [step("build", "running", "t-working")],
  });
  const planning = feature({
    id: "planning",
    state: "working",
    stage: "plan",
    steps: [step("plan", "running", "t-plan")],
  });
  const done = feature({ id: "done", state: "done", stage: null, steps: [] });
  const other = feature({
    id: "other",
    state: "working",
    stage: "plan",
    steps: [],
    workflowId: "bug-fix",
  });
  const features = [atDesign, failed, working, planning, done, other];

  it("lists what needs a person, oldest first", () => {
    expect(crewNeedsYou(features).map((item) => item.record.id)).toEqual(["failed", "kanban"]);
  });

  it("groups the rest by stage in order, with Done last", () => {
    expect(
      crewGroupByPhase(features).map((group) => [
        group.label,
        group.features.map((item) => item.record.id),
      ]),
    ).toEqual([
      ["Plan", ["planning", "other"]],
      ["Build", ["working"]],
      ["Done", ["done"]],
    ]);
  });

  it("groups one workflow by stage with gate rows and counts the hidden features", () => {
    const { items, hiddenCount } = crewGroupByStage(features, definition);
    expect(hiddenCount).toBe(1);
    expect(
      items.map((item) =>
        item.kind === "gate"
          ? `${item.label} · ${item.waiting}`
          : `${item.label} (${item.features.length})`,
      ),
    ).toEqual([
      "Plan (1)",
      "Approve plan · 0",
      "Design (1)",
      "Approve design · 1",
      "Build (2)",
      "Done (1)",
    ]);
  });
});
