import {
  ProviderInstanceId,
  ThreadId,
  workflowForwardStages,
  type WorkflowDefinition,
  type WorkflowStepEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  featureCardState,
  featureStage,
  projectWorkflowState,
  type WorkflowState,
} from "./WorkflowState.ts";

const definition: WorkflowDefinition = {
  schemaVersion: 2,
  id: "delivery",
  name: "Delivery",
  revision: 1,
  start: "build",
  roles: {
    builder: { roleId: "builder", roleRevision: 1, supervisor: null },
  },
  steps: {
    build: { type: "task", role: "builder", task: "Build", next: { built: "review" } },
    review: {
      type: "task",
      role: "builder",
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
  runId: null,
  outcome: null,
  sourceKind: kind === "question" || kind === "answered" || kind === "failed" ? "handoff" : null,
  sourceId: kind === "question" || kind === "answered" || kind === "failed" ? "handoff-1" : null,
  actorId: "manager",
  detail: null,
  occurredAt: "2026-09-29T00:00:00Z",
  ...fields,
});
const start = (id: string, stepId: string, executionId: string, runId: string) =>
  event(id, stepId, "started", {
    executionId,
    runId,
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

  it("retries within the execution with a fresh run, as often as a person asks", () => {
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
    const model = { instanceId: ProviderInstanceId.make("claude"), model: "claude-opus-5-5" };
    history.push(
      event("retry-again", "build", "retry", { executionId: "execution-1", modelSelection: model }),
    );
    expect(projectWorkflowState(definition, history).steps.get("build")).toMatchObject({
      status: "pending",
      modelSelection: model,
    });
    history.push(start("third", "build", "execution-1", "run-3"));
    expect(projectWorkflowState(definition, history).steps.get("build")).toMatchObject({
      attempt: 3,
      modelSelection: model,
    });
    expect(() =>
      projectWorkflowState(definition, [
        ...history,
        event("retry-running", "build", "retry", { executionId: "execution-1" }),
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

  const gated: WorkflowDefinition = {
    ...definition,
    steps: {
      plan: { type: "task", role: "builder", task: "Plan", next: { ready: "build" }, gate: true },
      build: { type: "task", role: "builder", task: "Build", next: { built: "review" } },
      review: {
        type: "task",
        role: "builder",
        task: "Review",
        next: { approved: "end", changes_requested: "build" },
        limits: { changes_requested: 1 },
      },
      end: { type: "end" },
    },
    start: "plan",
    defaults: { ...definition.defaults, maxStepExecutions: 20 },
  };
  const project = (history: ReadonlyArray<WorkflowStepEvent>) =>
    projectWorkflowState(gated, history);
  const status = (state: WorkflowState, stepId: string) => state.steps.get(stepId)?.status;
  const throughReview = () => [
    start("p1", "plan", "e1", "r1"),
    complete("p1-done", "plan", "e1", "ready"),
    event("approve", "plan", "approved", { executionId: "e1", detail: "Keep it small" }),
    start("b1", "build", "e2", "r2"),
    complete("b1-done", "build", "e2", "built"),
    start("v1", "review", "e3", "r3"),
  ];

  it("holds a gated stage for approval, and reruns it when changes are requested", () => {
    const waiting = [start("p1", "plan", "e1", "r1"), complete("p1-done", "plan", "e1", "ready")];
    expect(project(waiting).steps.get("plan")).toMatchObject({
      status: "awaiting-approval",
      pendingOutcome: "ready",
    });
    expect(featureCardState(project(waiting), false)).toBe("approval");
    expect(project(waiting).readyStepIds).toEqual([]);
    expect(() =>
      project([...waiting, event("note-less", "plan", "changes-requested", { executionId: "e1" })]),
    ).toThrow(/Invalid changes-requested/);
    const rerun = [
      ...waiting,
      event("changes", "plan", "changes-requested", { executionId: "e1", detail: "Add risks" }),
    ];
    expect(project(rerun).steps.get("plan")).toMatchObject({
      status: "pending",
      executionId: null,
    });
    expect(project([...rerun, start("p2", "plan", "e4", "r4")]).executionCount).toBe(2);
    const approved = [...waiting, event("ok", "plan", "approved", { executionId: "e1" })];
    expect(project(approved).activeStepId).toBe("build");
    expect(status(project(approved), "plan")).toBe("completed");
  });

  it("stops a looping route at Your call, then accepts or allows one more round", () => {
    const firstLoop = [
      ...throughReview(),
      complete("v1-done", "review", "e3", "changes_requested"),
      start("b2", "build", "e4", "r4"),
      complete("b2-done", "build", "e4", "built"),
      start("v2", "review", "e5", "r5"),
      complete("v2-done", "review", "e5", "changes_requested"),
    ];
    const held = project(firstLoop);
    expect(held.yourCall).toEqual({
      reason: "loop-limit",
      stepId: "review",
      outcome: "changes_requested",
      target: "build",
    });
    expect(status(held, "review")).toBe("limit-reached");
    expect(featureCardState(held, false)).toBe("your-call");
    const accepted = project([
      ...firstLoop,
      event("accept", "review", "accepted", { executionId: "e5", outcome: "approved" }),
    ]);
    expect(accepted.completed).toBe(true);
    expect(featureCardState(accepted, false)).toBe("done");
    const extended = project([
      ...firstLoop,
      event("more", "review", "extended", { executionId: "e5" }),
    ]);
    expect(extended.activeStepId).toBe("build");
    expect(extended.yourCall).toBeNull();
  });

  it("stops at Your call when the execution limit is used up", () => {
    const tight = { ...gated, defaults: { ...gated.defaults, maxStepExecutions: 2 } };
    const history = [
      start("p1", "plan", "e1", "r1"),
      complete("p1-done", "plan", "e1", "ready"),
      event("approve", "plan", "approved", { executionId: "e1" }),
      start("b1", "build", "e2", "r2"),
      complete("b1-done", "build", "e2", "built"),
    ];
    const held = projectWorkflowState(tight, history);
    expect(held.yourCall?.reason).toBe("execution-limit");
    const more = projectWorkflowState(tight, [
      ...history,
      event("more", "build", "extended", { executionId: "e2" }),
    ]);
    expect(more.activeStepId).toBe("review");
    expect(more.readyStepIds).toEqual(["review"]);
  });

  it("lets a person take over a stage and mark it done, ignoring bot results", () => {
    const history = [
      ...throughReview(),
      event("take", "review", "taken-over", { executionId: "e3" }),
    ];
    expect(status(project(history), "review")).toBe("taken-over");
    expect(featureCardState(project(history), false)).toBe("working");
    expect(() => project([...history, complete("late", "review", "e3", "approved")])).toThrow(
      /Invalid completed/,
    );
    expect(() =>
      project([
        ...history,
        event("no-summary", "review", "marked-done", { executionId: "e3", outcome: "approved" }),
      ]),
    ).toThrow(/Invalid marked-done/);
    const done = project([
      ...history,
      event("done", "review", "marked-done", {
        executionId: "e3",
        outcome: "approved",
        detail: "Reviewed by hand",
      }),
    ]);
    expect(done.completed).toBe(true);
    const retried = project([...history, event("again", "review", "retry", { executionId: "e3" })]);
    expect(status(retried, "review")).toBe("pending");
  });

  it("retries automatically only after a failure it cites", () => {
    const failed = [
      ...throughReview(),
      event("fail", "review", "failed", { executionId: "e3", detail: "Crashed" }),
    ];
    expect(featureCardState(project(failed), false)).toBe("failed");
    expect(() =>
      project([
        ...failed,
        event("auto", "review", "retry", {
          executionId: "e3",
          sourceKind: "workflow",
          sourceId: null,
        }),
      ]),
    ).toThrow(/Invalid retry/);
    const retried = project([
      ...failed,
      event("auto", "review", "retry", {
        executionId: "e3",
        sourceKind: "workflow",
        sourceId: "fail",
      }),
    ]);
    expect(retried.readyStepIds).toEqual(["review"]);
  });

  it("sends a stage back to an earlier one and resets everything after it", () => {
    const failed = [
      ...throughReview(),
      event("fail", "review", "failed", { executionId: "e3", detail: "Broken build" }),
    ];
    expect(() =>
      project([
        ...failed,
        event("future", "review", "sent-back", { executionId: "e3", targetStepId: "review" }),
      ]),
    ).toThrow(/Invalid sent-back/);
    const sent = project([
      ...failed,
      event("back", "review", "sent-back", {
        executionId: "e3",
        targetStepId: "build",
        detail: "Broken build: fix the import",
      }),
    ]);
    expect(sent.activeStepId).toBe("build");
    expect(status(sent, "build")).toBe("pending");
    expect(status(sent, "review")).toBe("pending");
    expect(status(sent, "plan")).toBe("completed");
  });

  it("skips a failed stage along its first unlimited route", () => {
    const skipped = project([
      ...throughReview(),
      event("fail", "review", "failed", { executionId: "e3", detail: "Flaky" }),
      event("skip", "review", "skipped", { executionId: "e3", outcome: "approved" }),
    ]);
    expect(skipped.completed).toBe(true);
    expect(status(skipped, "review")).toBe("skipped");
  });

  it("reopens a cancelled feature where it stopped, and Done at a chosen stage", () => {
    const cancelled = [
      ...throughReview(),
      event("cancel", "review", "cancelled", { executionId: "e3" }),
    ];
    expect(featureCardState(project(cancelled), false)).toBe("cancelled");
    expect(featureStage(gated, project(cancelled))).toEqual({
      stepId: "review",
      index: 3,
      total: 3,
    });
    expect(() => project([...cancelled, event("elsewhere", "build", "reopened")])).toThrow(
      /Invalid reopened/,
    );
    const resumed = project([...cancelled, event("reopen", "review", "reopened")]);
    expect(resumed.cancelled).toBe(false);
    expect(resumed.steps.get("review")).toMatchObject({ status: "pending", executionId: "e3" });
    const resumedHistory = [
      ...cancelled,
      event("reopen", "review", "reopened"),
      start("v2", "review", "e3", "r4"),
    ];
    expect(project(resumedHistory).steps.get("review")?.attempt).toBe(2);
    const done = [...resumedHistory, complete("v2-done", "review", "e3", "approved")];
    expect(project(done).completed).toBe(true);
    const followUp = project([...done, event("follow-up", "build", "reopened")]);
    expect(followUp.completed).toBe(false);
    expect(followUp.activeStepId).toBe("build");
    expect(status(followUp, "review")).toBe("pending");
    expect(status(followUp, "end")).toBe("pending");
  });

  it("attaches a person's thread as a stage and completes it through the gate", () => {
    const thread = ThreadId.make("thread:person");
    const attach = (stepId: string) =>
      event(`attach-${stepId}`, stepId, "attached", {
        executionId: `x-${stepId}`,
        threadId: thread,
      });
    const finished = (stepId: string, outcome: string) =>
      event(`done-${stepId}`, stepId, "completed", {
        executionId: `x-${stepId}`,
        outcome,
        sourceKind: "workflow",
        sourceId: "run:person",
        detail: "Fixed it",
      });
    expect(workflowForwardStages(gated)).toEqual(["plan", "build", "review"]);

    const atBuild = [event("skip-plan", "plan", "skipped", { outcome: "ready" }), attach("build")];
    expect(project(atBuild).steps.get("build")).toMatchObject({
      status: "taken-over",
      threadId: thread,
      runId: null,
    });
    expect(status(project(atBuild), "plan")).toBe("skipped");
    expect(project(atBuild).readyStepIds).toEqual([]);
    expect(project([...atBuild, finished("build", "built")]).activeStepId).toBe("review");

    // A gated stage waits for approval even when its thread finished on its own.
    expect(project([attach("plan"), finished("plan", "ready")]).steps.get("plan")).toMatchObject({
      status: "awaiting-approval",
      pendingOutcome: "ready",
    });
    // Only attached stages complete from the workflow; bot stages need their handoff.
    expect(() =>
      project([
        start("p1", "plan", "e1", "r1"),
        event("p1-done", "plan", "completed", {
          executionId: "e1",
          outcome: "ready",
          sourceKind: "workflow",
          sourceId: "run",
          detail: "Done",
        }),
      ]),
    ).toThrow(/Invalid completed/);
    expect(() => project([start("p1", "plan", "e1", "r1"), attach("plan")])).toThrow(
      /Invalid attached/,
    );
    expect(() => project([event("bare", "plan", "attached", { executionId: "x-plan" })])).toThrow(
      /Invalid attached/,
    );

    // Cancel (Detach) and Reopen hand the stage back to the same thread.
    const detached = [
      ...atBuild,
      event("detach", "build", "cancelled", { executionId: "x-build" }),
    ];
    expect(project(detached).cancelled).toBe(true);
    const reopened = project([...detached, event("reopen", "build", "reopened")]);
    expect(reopened.steps.get("build")).toMatchObject({ status: "taken-over", threadId: thread });
    expect(reopened.readyStepIds).toEqual([]);
    // Retry hands an attached stage to its bot.
    const retried = project([
      ...atBuild,
      event("retry", "build", "retry", { executionId: "x-build" }),
    ]);
    expect(retried.steps.get("build")).toMatchObject({ status: "pending", threadId: null });
    expect(retried.readyStepIds).toEqual(["build"]);
  });

  it("orders card states so what needs a person wins", () => {
    const waiting = project([start("p1", "plan", "e1", "r1")]);
    expect(featureCardState(waiting, false)).toBe("working");
    expect(featureCardState(project([]), true)).toBe("queued");
    const paused = project([event("pause", "plan", "paused")]);
    expect(featureCardState(paused, true)).toBe("paused");
    const asking = project([
      start("p1", "plan", "e1", "r1"),
      event("ask", "plan", "question", { executionId: "e1", detail: "Which?" }),
      event("pause", "plan", "paused", { executionId: "e1" }),
    ]);
    expect(featureCardState(asking, false)).toBe("input");
  });
});
