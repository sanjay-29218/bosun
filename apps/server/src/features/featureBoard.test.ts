import {
  ProjectId,
  ThreadId,
  type WorkflowDefinition,
  type WorkflowStepEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectWorkflowState } from "../workflows/WorkflowState.ts";
import type { FeatureRecord } from "./FeatureService.ts";
import { featureBoardCard, featureBoardRunId } from "./featureBoard.ts";

const projectId = ProjectId.make("board-project");
const definition: WorkflowDefinition = {
  schemaVersion: 2,
  id: "delivery",
  name: "Delivery",
  revision: 2,
  start: "plan",
  roles: {
    planner: { roleId: "planner", roleRevision: 1, supervisor: null },
    builder: { roleId: "builder", roleRevision: 1, supervisor: null },
  },
  steps: {
    plan: { type: "task", role: "planner", task: "Plan", next: { ready: "build" }, gate: true },
    build: { type: "task", role: "builder", task: "Build", next: { built: "end" } },
    end: { type: "end" },
  },
  defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 8 },
};
const feature: FeatureRecord = {
  id: "feature-1",
  projectId,
  title: "Kanban board",
  brief: "Build it",
  workflowId: "delivery",
  workflowRevision: 2,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  status: "open",
  crewAssignments: {},
};
const copy = {
  featureId: feature.id,
  projectId,
  definition,
  eventVersion: 0,
  createdAt: "2026-10-01T00:00:00.000Z",
};
const handoffEvent = (
  id: string,
  stepId: string,
  kind: WorkflowStepEvent["kind"],
  occurredAt: string,
  fields: Partial<WorkflowStepEvent> = {},
): WorkflowStepEvent => ({
  id,
  stepId,
  kind,
  executionId: `${stepId}-execution`,
  runId: null,
  outcome: null,
  sourceKind: "handoff",
  sourceId: `handoff-${id}`,
  actorId: "bot",
  detail: null,
  occurredAt,
  ...fields,
});
const started = (stepId: string, occurredAt: string) =>
  handoffEvent(`start-${stepId}`, stepId, "started", occurredAt, { runId: `run-${stepId}` });

const card = (
  events: ReadonlyArray<WorkflowStepEvent>,
  execution: { queuedAt: string | null; lastError: string | null } | null = {
    queuedAt: null,
    lastError: null,
  },
) =>
  featureBoardCard({
    feature,
    copy,
    state: projectWorkflowState(definition, events),
    events,
    execution,
    latestRevision: 3,
    threadId: ThreadId.make("stage-thread"),
  });

describe("feature board cards", () => {
  it("shows an unstarted feature at its first stage since it was created", () => {
    const result = card([], null);
    expect(result.started).toBe(false);
    expect(result.stateSince).toBe(copy.createdAt);
    expect(result.stage).toEqual({
      stepId: "plan",
      index: 1,
      total: 2,
      role: "planner",
      attempt: 0,
      gate: true,
      takenOver: false,
    });
    expect(result.workflow).toEqual({
      id: "delivery",
      name: "Delivery",
      revision: 2,
      latestRevision: 3,
    });
  });

  it("explains a gate with the stage's completion summary", () => {
    const result = card([
      started("plan", "2026-10-01T01:00:00.000Z"),
      handoffEvent("done-plan", "plan", "completed", "2026-10-01T02:00:00.000Z", {
        outcome: "ready",
        detail: "plan.md is ready",
      }),
    ]);
    expect(result.state).toBe("approval");
    expect(result.detail).toBe("plan.md is ready");
    expect(result.stateSince).toBe("2026-10-01T02:00:00.000Z");
  });

  it("keeps a waiting state's age across a pause and resume", () => {
    const decision = (id: string, kind: WorkflowStepEvent["kind"], occurredAt: string) =>
      handoffEvent(id, "plan", kind, occurredAt, { sourceKind: null, sourceId: null });
    const result = card([
      started("plan", "2026-10-01T01:00:00.000Z"),
      handoffEvent("done-plan", "plan", "completed", "2026-10-01T02:00:00.000Z", {
        outcome: "ready",
        detail: "plan.md is ready",
      }),
      decision("pause", "paused", "2026-10-01T03:00:00.000Z"),
      decision("resume", "resumed", "2026-10-01T04:00:00.000Z"),
    ]);
    expect(result.state).toBe("approval");
    expect(result.stateSince).toBe("2026-10-01T02:00:00.000Z");
  });

  it("marks a stage a person took over", () => {
    const result = card([
      started("plan", "2026-10-01T01:00:00.000Z"),
      handoffEvent("fail", "plan", "failed", "2026-10-01T01:50:00.000Z", { detail: "stuck" }),
      handoffEvent("take", "plan", "taken-over", "2026-10-01T02:00:00.000Z", {
        sourceKind: null,
        sourceId: null,
      }),
    ]);
    expect(result.state).toBe("working");
    expect(result.stage?.takenOver).toBe(true);
  });

  it("carries a question's text and the failure that replaced it", () => {
    const asked = [
      started("plan", "2026-10-01T01:00:00.000Z"),
      handoffEvent("ask", "plan", "question", "2026-10-01T01:30:00.000Z", {
        detail: "Should presets sync across devices?",
      }),
    ];
    expect(card(asked).state).toBe("input");
    expect(card(asked).detail).toBe("Should presets sync across devices?");

    const failed = card([
      ...asked,
      handoffEvent("fail", "plan", "failed", "2026-10-01T01:50:00.000Z", {
        detail: "typecheck failed",
      }),
    ]);
    expect(failed.state).toBe("failed");
    expect(failed.detail).toBe("typecheck failed");
  });

  it("dates a queued feature from when it was queued and trims long details", () => {
    const queued = card([], { queuedAt: "2026-10-02T00:00:00.000Z", lastError: null });
    expect(queued.state).toBe("queued");
    expect(queued.started).toBe(true);
    expect(queued.stateSince).toBe("2026-10-02T00:00:00.000Z");

    const long = card([
      started("plan", "2026-10-01T01:00:00.000Z"),
      handoffEvent("ask", "plan", "question", "2026-10-01T01:30:00.000Z", {
        detail: "x".repeat(400),
      }),
    ]);
    expect(long.detail).toHaveLength(280);
    expect(long.detail?.endsWith("…")).toBe(true);
  });

  it("opens the stage's own run, else the latest run", () => {
    const events = [started("plan", "2026-10-01T01:00:00.000Z")];
    const state = projectWorkflowState(definition, events);
    expect(featureBoardRunId(state, events, "plan")).toBe("run-plan");
    expect(featureBoardRunId(state, events, "build")).toBe("run-plan");
    expect(featureBoardRunId(state, [], null)).toBeNull();
  });
});
