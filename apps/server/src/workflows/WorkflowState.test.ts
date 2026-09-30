import type { WorkflowDefinition, WorkflowStepEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectWorkflowState } from "./WorkflowState.ts";

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "delivery",
  name: "Delivery",
  revision: 1,
  start: "build",
  bots: {
    builder: { template: { kind: "template", id: "builder", revision: 1 }, supervisor: null },
  },
  steps: {
    build: { type: "task", bot: "builder", task: "Build", next: { built: "review" } },
    review: {
      type: "task",
      bot: "builder",
      task: "Review",
      next: { approved: "end", changes_requested: "build" },
    },
    end: { type: "end" },
  },
  defaults: {
    questions: "supervisor",
    failure: "pause",
    maxAttemptsPerExecution: 2,
    maxStepExecutions: 4,
  },
};
const event = (
  id: string,
  stepId: string,
  kind: WorkflowStepEvent["kind"],
  fields: Partial<WorkflowStepEvent> = {},
): WorkflowStepEvent => ({
  id,
  stepId,
  kind,
  executionId: null,
  botRunId: null,
  outcome: null,
  sourceKind: kind === "question" || kind === "answered" || kind === "failed" ? "handoff" : null,
  sourceId: kind === "question" || kind === "answered" || kind === "failed" ? "handoff-1" : null,
  actorId: "manager",
  detail: null,
  occurredAt: "2026-09-29T00:00:00Z",
  ...fields,
});
const start = (id: string, stepId: string, executionId: string, botRunId: string) =>
  event(id, stepId, "started", {
    executionId,
    botRunId,
    sourceKind: "handoff",
    sourceId: `handoff-${id}`,
  });
const complete = (id: string, stepId: string, executionId: string, outcome: string) =>
  event(id, stepId, "completed", {
    executionId,
    outcome,
    sourceKind: "handoff",
    sourceId: `handoff-${id}`,
    detail: "Work completed",
  });

describe("workflow step history", () => {
  it("blocks questions, routes rework to a new execution, and finishes on approval", () => {
    const history = [
      start("start-build", "build", "execution-1", "run-1"),
      event("ask", "build", "question", { executionId: "execution-1", detail: "Which API?" }),
    ];
    expect(projectWorkflowState(definition, history).steps.get("build")?.status).toBe(
      "needs-input",
    );
    expect(() =>
      projectWorkflowState(definition, [
        ...history,
        complete("premature", "build", "execution-1", "built"),
      ]),
    ).toThrow(/Invalid completed/);
    history.push(
      event("answer", "build", "answered", { executionId: "execution-1", detail: "Current API" }),
    );
    history.push(complete("built", "build", "execution-1", "built"));
    history.push(start("start-review", "review", "execution-2", "run-2"));
    history.push(complete("changes", "review", "execution-2", "changes_requested"));
    expect(projectWorkflowState(definition, history).readyStepIds).toEqual(["build"]);
    history.push(start("rebuild", "build", "execution-3", "run-3"));
    expect(projectWorkflowState(definition, history).steps.get("build")).toMatchObject({
      executionId: "execution-3",
      attempt: 1,
      status: "running",
    });
    history.push(complete("rebuilt", "build", "execution-3", "built"));
    history.push(start("review-again", "review", "execution-4", "run-4"));
    history.push(complete("approved", "review", "execution-4", "approved"));
    expect(projectWorkflowState(definition, history)).toMatchObject({
      completed: true,
      executionCount: 4,
    });
    expect(projectWorkflowState(definition, history).steps.get("end")?.status).toBe("completed");
  });

  it("retries within the execution with a fresh run and respects limits", () => {
    const history = [
      start("start", "build", "execution-1", "run-1"),
      event("failed", "build", "failed", {
        executionId: "execution-1",
        detail: "Provider unavailable",
      }),
      event("retry", "build", "retry", { executionId: "execution-1" }),
    ];
    expect(projectWorkflowState(definition, history).readyStepIds).toEqual(["build"]);
    expect(() =>
      projectWorkflowState(definition, [
        ...history,
        start("reused", "build", "execution-1", "run-1"),
      ]),
    ).toThrow(/Invalid started/);
    history.push(start("restart", "build", "execution-1", "run-2"));
    expect(projectWorkflowState(definition, history).steps.get("build")).toMatchObject({
      attempt: 2,
      executionId: "execution-1",
    });
    history.push(
      event("failed-again", "build", "failed", {
        executionId: "execution-1",
        detail: "Still unavailable",
      }),
    );
    expect(() =>
      projectWorkflowState(definition, [
        ...history,
        event("retry-again", "build", "retry", { executionId: "execution-1" }),
      ]),
    ).toThrow(/Invalid retry/);
  });

  it("rejects unsupported outcomes and makes cancellation terminal", () => {
    expect(() =>
      projectWorkflowState(definition, [
        start("start", "build", "execution-1", "run-1"),
        complete("wrong", "build", "execution-1", "turn_ended"),
      ]),
    ).toThrow(/Invalid completed/);
    const cancelled = [event("cancel", "build", "cancelled")];
    expect(projectWorkflowState(definition, cancelled).cancelled).toBe(true);
    expect(() =>
      projectWorkflowState(definition, [
        ...cancelled,
        start("late", "build", "execution-1", "run-1"),
      ]),
    ).toThrow(/Invalid started/);
  });
});
