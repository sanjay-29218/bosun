import type { WorkflowDefinition, WorkflowStepEvent } from "@t3tools/contracts";

import { nextWorkflowStep, validateWorkflowDefinition } from "./WorkflowGraph.ts";

export class WorkflowTransitionError extends Error {
  readonly _tag = "WorkflowTransitionError";
}

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "needs-input"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowStepState {
  readonly id: string;
  readonly status: WorkflowStepStatus;
  readonly executionId: string | null;
  readonly attempt: number;
  readonly botRunId: string | null;
  readonly outcome: string | null;
}

export interface WorkflowState {
  readonly steps: ReadonlyMap<string, WorkflowStepState>;
  readonly readyStepIds: ReadonlyArray<string>;
  readonly activeStepId: string | null;
  readonly executionCount: number;
  readonly completed: boolean;
  readonly cancelled: boolean;
}

const nonEmpty = (value: string | null, max: number) =>
  value !== null && value.trim().length > 0 && value.length <= max;

/** Replays the active path; every rework execution remains in the durable event history. */
export const projectWorkflowState = (
  definition: WorkflowDefinition,
  events: ReadonlyArray<WorkflowStepEvent>,
): WorkflowState => {
  validateWorkflowDefinition(definition);
  if (events.length > 4096) throw new WorkflowTransitionError("Workflow history is too large");
  const steps = new Map<string, WorkflowStepState>(
    Object.keys(definition.steps).map((id) => [
      id,
      { id, status: "pending", executionId: null, attempt: 0, botRunId: null, outcome: null },
    ]),
  );
  const eventIds = new Set<string>();
  const executionIds = new Set<string>();
  const usedRunIds = new Set<string>();
  let activeStepId: string | null = definition.start;
  let executionCount = 0;
  let completed = false;
  let cancelled = false;

  for (const event of events) {
    if (
      !nonEmpty(event.id, 128) ||
      !nonEmpty(event.actorId, 128) ||
      !nonEmpty(event.occurredAt, 64) ||
      (event.detail !== null && event.detail.length > 16_000)
    ) {
      throw new WorkflowTransitionError("Invalid workflow event fields");
    }
    if (eventIds.has(event.id)) throw new WorkflowTransitionError("Duplicate workflow event ID");
    eventIds.add(event.id);
    const step = Object.hasOwn(definition.steps, event.stepId)
      ? definition.steps[event.stepId]
      : undefined;
    const previous = steps.get(event.stepId);
    const invalid = (): never => {
      throw new WorkflowTransitionError(`Invalid ${event.kind} transition for ${event.stepId}`);
    };
    if (
      !step ||
      !previous ||
      step.type !== "task" ||
      activeStepId !== event.stepId ||
      completed ||
      cancelled
    ) {
      throw new WorkflowTransitionError(`Invalid ${event.kind} transition for ${event.stepId}`);
    }
    const noSource = () => {
      if (event.sourceKind !== null || event.sourceId !== null) invalid();
    };
    const handoffSource = () => {
      if (event.sourceKind !== "handoff" || !nonEmpty(event.sourceId, 128)) invalid();
    };
    const sameExecution = () => {
      if (event.executionId !== previous.executionId || !nonEmpty(event.executionId, 128))
        invalid();
    };
    if (event.kind !== "completed" && event.outcome !== null) invalid();
    if (event.kind !== "started" && event.botRunId !== null && event.botRunId !== previous.botRunId)
      invalid();
    let current: WorkflowStepState;
    switch (event.kind) {
      case "started": {
        handoffSource();
        if (
          previous.status !== "pending" ||
          !nonEmpty(event.botRunId, 128) ||
          !nonEmpty(event.executionId, 128)
        )
          invalid();
        if (usedRunIds.has(event.botRunId!)) invalid();
        if (previous.executionId === null) {
          if (
            executionIds.has(event.executionId!) ||
            executionCount >= definition.defaults.maxStepExecutions
          )
            invalid();
          executionIds.add(event.executionId!);
          executionCount++;
        } else {
          sameExecution();
          if (previous.attempt >= definition.defaults.maxAttemptsPerExecution) invalid();
        }
        usedRunIds.add(event.botRunId!);
        current = {
          ...previous,
          status: "running",
          executionId: event.executionId,
          attempt: previous.attempt + 1,
          botRunId: event.botRunId,
          outcome: null,
        };
        break;
      }
      case "completed": {
        sameExecution();
        if (
          previous.status !== "running" ||
          event.sourceKind !== "handoff" ||
          !nonEmpty(event.sourceId, 128) ||
          !nonEmpty(event.outcome, 80) ||
          !nonEmpty(event.detail, 16_000)
        )
          invalid();
        let target: string;
        try {
          target = nextWorkflowStep(definition, event.stepId, event.outcome!);
        } catch {
          return invalid();
        }
        current = { ...previous, status: "completed", outcome: event.outcome };
        steps.set(event.stepId, current);
        if (definition.steps[target]?.type === "end") {
          steps.set(target, {
            id: target,
            status: "completed",
            executionId: null,
            attempt: 0,
            botRunId: null,
            outcome: null,
          });
          completed = true;
          activeStepId = null;
        } else {
          const targetStep = steps.get(target)!;
          steps.set(target, {
            ...targetStep,
            status: "pending",
            executionId: null,
            attempt: 0,
            botRunId: null,
            outcome: null,
          });
          activeStepId = target;
        }
        continue;
      }
      case "question": {
        handoffSource();
        sameExecution();
        if (previous.status !== "running" || !nonEmpty(event.detail, 16_000)) invalid();
        current = { ...previous, status: "needs-input" };
        break;
      }
      case "answered": {
        handoffSource();
        sameExecution();
        if (previous.status !== "needs-input" || !nonEmpty(event.detail, 16_000)) invalid();
        current = { ...previous, status: "running" };
        break;
      }
      case "failed": {
        if (
          (event.sourceKind !== "handoff" && event.sourceKind !== "workflow") ||
          !nonEmpty(event.sourceId, 128)
        )
          invalid();
        sameExecution();
        if (
          (previous.status !== "running" && previous.status !== "needs-input") ||
          !nonEmpty(event.detail, 16_000)
        )
          invalid();
        current = { ...previous, status: "failed" };
        break;
      }
      case "retry": {
        noSource();
        sameExecution();
        if (
          previous.status !== "failed" ||
          previous.attempt >= definition.defaults.maxAttemptsPerExecution ||
          event.botRunId !== null
        )
          invalid();
        current = { ...previous, status: "pending", botRunId: null };
        break;
      }
      case "cancelled": {
        noSource();
        if (previous.status === "pending" && previous.executionId === null) {
          if (event.executionId !== null || event.botRunId !== null) invalid();
        } else {
          sameExecution();
        }
        current = { ...previous, status: "cancelled" };
        cancelled = true;
        activeStepId = null;
        break;
      }
    }
    steps.set(event.stepId, current);
  }

  return {
    steps,
    readyStepIds:
      activeStepId !== null && steps.get(activeStepId)?.status === "pending" ? [activeStepId] : [],
    activeStepId,
    executionCount,
    completed,
    cancelled,
  };
};
