import { ThreadId, type WorkflowStepEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { stageThreadSummaries } from "./CrewStageThreads.ts";
import { makeStarterWorkflow } from "./starterWorkflow.ts";

const definition = makeStarterWorkflow();

const started = (id: string, stepId: string, runId: string): WorkflowStepEvent => ({
  id,
  stepId,
  executionId: `${stepId}-execution`,
  kind: "started",
  runId,
  outcome: null,
  sourceKind: "handoff",
  sourceId: `handoff-${id}`,
  actorId: "workflow",
  detail: null,
  occurredAt: "2026-10-09T10:00:00.000Z",
});

const runThreads = new Map([
  ["run-plan", ThreadId.make("thread-plan")],
  ["run-design-1", ThreadId.make("thread-design-1")],
  ["run-design-2", ThreadId.make("thread-design-2")],
]);

describe("stageThreadSummaries", () => {
  it("labels each thread with its own stage and marks only the latest start current", () => {
    const summaries = stageThreadSummaries({
      featureId: "feature",
      definition,
      events: [
        started("1", "plan", "run-plan"),
        started("2", "design", "run-design-1"),
        started("3", "design", "run-design-2"),
      ],
      state: "approval",
      revision: 7,
      runThreads,
    });
    expect(summaries).toEqual([
      {
        threadId: "thread-plan",
        summary: {
          featureId: "feature",
          stepId: "plan",
          index: 1,
          total: 6,
          state: "approval",
          current: false,
        },
      },
      {
        threadId: "thread-design-1",
        summary: expect.objectContaining({ stepId: "design", index: 2, current: false }),
      },
      {
        threadId: "thread-design-2",
        summary: expect.objectContaining({
          stepId: "design",
          index: 2,
          current: true,
          revision: 7,
        }),
      },
    ]);
  });

  it("moves the current row back to a thread that runs again", () => {
    const summaries = stageThreadSummaries({
      featureId: "feature",
      definition,
      events: [
        started("1", "plan", "run-plan"),
        started("2", "design", "run-design-1"),
        // A run that lands on an earlier thread again (as a takeover thread does).
        started("3", "plan", "run-plan"),
      ],
      state: "working",
      revision: 7,
      runThreads,
    });
    expect(summaries.map(({ threadId, summary }) => [threadId, summary.current])).toEqual([
      ["thread-design-1", false],
      ["thread-plan", true],
    ]);
  });

  it("skips runs whose thread is unknown", () => {
    expect(
      stageThreadSummaries({
        featureId: "feature",
        definition,
        events: [started("1", "plan", "run-missing")],
        state: "working",
        revision: 7,
        runThreads,
      }),
    ).toEqual([]);
  });
});
