import type { WorkflowDefinition, WorkflowStepEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { projectWorkflowState } from "./WorkflowState.ts";

const definition: WorkflowDefinition = {
  id: "delivery",
  name: "Delivery",
  revision: 1,
  steps: [
    { id: "plan", kind: "bot", templateId: "planner", completion: "handoff", dependsOn: [] },
    { id: "review", kind: "decision", approver: { kind: "person" }, dependsOn: ["plan"] },
    { id: "end", kind: "end", dependsOn: ["review"] },
  ],
};

const event = (
  id: string,
  stepId: string,
  kind: WorkflowStepEvent["kind"],
  overrides: Partial<WorkflowStepEvent> = {},
): WorkflowStepEvent => ({
  id,
  stepId,
  kind,
  botRunId: null,
  sourceKind: null,
  sourceId: null,
  actorId: "manager",
  detail: null,
  occurredAt: "2026-09-29T00:00:00.000Z",
  ...overrides,
});

const started = event("start-plan", "plan", "started", { botRunId: "run-1" });
const completed = event("complete-plan", "plan", "completed", {
  sourceKind: "handoff",
  sourceId: "handoff-1",
});

describe("workflow step history", () => {
  it("keeps questions and change requests blocked until their recorded answers", () => {
    const history = [started, event("ask", "plan", "question", { detail: "Which API?" })];
    expect(projectWorkflowState(definition, history).steps.get("plan")?.status).toBe("needs-input");
    expect(() => projectWorkflowState(definition, [...history, completed])).toThrow(
      /Invalid completed transition/,
    );

    history.push(event("answer", "plan", "answered", { detail: "Use the existing API" }));
    history.push(event("change", "plan", "change-requested", { detail: "Revise the design" }));
    expect(projectWorkflowState(definition, history).steps.get("plan")?.status).toBe(
      "change-requested",
    );
    expect(projectWorkflowState(definition, history).readyStepIds).toEqual([]);
    history.push(
      event("resolve", "plan", "change-resolved", {
        sourceKind: "decision",
        sourceId: "manager-decision-1",
        detail: "Designer updated the design; continue",
      }),
    );
    history.push(completed);
    expect(projectWorkflowState(definition, history).readyStepIds).toEqual(["review"]);

    history.push(event("start-review", "review", "started"));
    history.push(
      event("approve", "review", "completed", {
        sourceKind: "decision",
        sourceId: "review-decision-1",
      }),
    );
    expect(projectWorkflowState(definition, history).readyStepIds).toEqual(["end"]);
    history.push(
      event("finish", "end", "completed", {
        sourceKind: "workflow",
        sourceId: "feature-completion-1",
      }),
    );
    expect(projectWorkflowState(definition, history).completed).toBe(true);
  });

  it("preserves failed attempts and requires a new bot run after retry", () => {
    const failed = event("failed", "plan", "failed", { detail: "Provider unavailable" });
    const retry = event("retry", "plan", "retry");
    const history = [started, failed, retry];
    const pending = projectWorkflowState(definition, history);
    expect(pending.steps.get("plan")).toMatchObject({ status: "pending", attempt: 1 });
    expect(pending.readyStepIds).toEqual(["plan"]);
    expect(() =>
      projectWorkflowState(definition, [
        ...history,
        event("start-again", "plan", "started", { botRunId: "run-1" }),
      ]),
    ).toThrow(/Invalid started transition/);
    const restarted = projectWorkflowState(definition, [
      ...history,
      event("start-again", "plan", "started", { botRunId: "run-2" }),
    ]);
    expect(restarted.steps.get("plan")).toMatchObject({
      status: "running",
      attempt: 2,
      botRunId: "run-2",
    });
  });

  it("rejects premature completion, unsupported outcomes, and work after cancellation", () => {
    expect(() => projectWorkflowState(definition, [completed])).toThrow(
      /Invalid completed transition/,
    );
    expect(() =>
      projectWorkflowState(definition, [event("review-first", "review", "started")]),
    ).toThrow(/Invalid started transition/);
    expect(() =>
      projectWorkflowState(definition, [
        started,
        event("wrong-source", "plan", "completed", {
          sourceKind: "decision",
          sourceId: "some-decision",
        }),
      ]),
    ).toThrow(/Invalid completed transition/);
    expect(() =>
      projectWorkflowState(definition, [
        started,
        event("cancel", "plan", "cancelled"),
        event("retry", "plan", "retry"),
      ]),
    ).toThrow(/Invalid retry transition/);
  });
});
