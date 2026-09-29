import type { WorkflowDefinition, WorkflowStepEvent } from "@t3tools/contracts";

import { validateWorkflowDefinition } from "./WorkflowGraph.ts";

export class WorkflowTransitionError extends Error {
  readonly _tag = "WorkflowTransitionError";
}

export type WorkflowStepStatus =
  | "pending"
  | "running"
  | "needs-input"
  | "change-requested"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowStepState {
  readonly id: string;
  readonly status: WorkflowStepStatus;
  readonly attempt: number;
  readonly botRunId: string | null;
}

export interface WorkflowState {
  readonly steps: ReadonlyMap<string, WorkflowStepState>;
  readonly readyStepIds: ReadonlyArray<string>;
  readonly completed: boolean;
}

const nonEmpty = (value: string | null, max: number) =>
  value !== null && value.trim().length > 0 && value.length <= max;

/** Replays durable step outcomes; a provider turn ending is not an event here. */
export const projectWorkflowState = (
  definition: WorkflowDefinition,
  events: ReadonlyArray<WorkflowStepEvent>,
): WorkflowState => {
  const ordered = validateWorkflowDefinition(definition);
  if (events.length > 4096) throw new WorkflowTransitionError("Workflow history is too large");
  const steps = new Map<string, WorkflowStepState>(
    ordered.map((step) => [
      step.id,
      { id: step.id, status: "pending", attempt: 0, botRunId: null },
    ]),
  );
  const definitionById = new Map(ordered.map((step) => [step.id, step]));
  const eventIds = new Set<string>();
  const usedRunIds = new Set<string>();
  const dependenciesComplete = (stepId: string) =>
    definitionById
      .get(stepId)!
      .dependsOn.every((dependency) => steps.get(dependency)?.status === "completed");

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
    const step = definitionById.get(event.stepId);
    const previous = steps.get(event.stepId);
    if (!step || !previous) throw new WorkflowTransitionError("Unknown workflow step");
    const invalid = () => {
      throw new WorkflowTransitionError(`Invalid ${event.kind} transition for ${event.stepId}`);
    };
    const requireNoSource = () => {
      if (event.sourceKind !== null || event.sourceId !== null) invalid();
    };
    const requireSource = (kind: NonNullable<WorkflowStepEvent["sourceKind"]>) => {
      if (event.sourceKind !== kind || !nonEmpty(event.sourceId, 128)) invalid();
    };
    const requireDetail = () => {
      if (!nonEmpty(event.detail, 16_000)) invalid();
    };
    let status: WorkflowStepStatus = previous.status;
    let attempt = previous.attempt;
    let botRunId = previous.botRunId;
    switch (event.kind) {
      case "started": {
        requireNoSource();
        if (
          previous.status !== "pending" ||
          step.kind === "end" ||
          !dependenciesComplete(step.id)
        ) {
          invalid();
        }
        const needsBotRun =
          step.kind === "bot" || (step.kind === "decision" && step.approver.kind === "bot");
        if (needsBotRun !== nonEmpty(event.botRunId, 128)) invalid();
        if (event.botRunId !== null) {
          if (usedRunIds.has(event.botRunId)) invalid();
          usedRunIds.add(event.botRunId);
        }
        status = "running";
        attempt += 1;
        botRunId = event.botRunId;
        break;
      }
      case "completed": {
        if (step.kind === "end") {
          requireSource("workflow");
          if (previous.status !== "pending" || !dependenciesComplete(step.id)) invalid();
        } else {
          requireSource(step.kind === "bot" ? "handoff" : "decision");
          if (previous.status !== "running") invalid();
        }
        status = "completed";
        break;
      }
      case "question":
      case "change-requested": {
        requireNoSource();
        requireDetail();
        if (previous.status !== "running") invalid();
        status = event.kind === "question" ? "needs-input" : "change-requested";
        break;
      }
      case "answered": {
        requireNoSource();
        requireDetail();
        if (previous.status !== "needs-input") invalid();
        status = "running";
        break;
      }
      case "change-resolved": {
        requireSource("decision");
        requireDetail();
        if (previous.status !== "change-requested") invalid();
        status = "running";
        break;
      }
      case "failed": {
        requireNoSource();
        requireDetail();
        if (
          previous.status !== "running" &&
          previous.status !== "needs-input" &&
          previous.status !== "change-requested"
        ) {
          invalid();
        }
        status = "failed";
        break;
      }
      case "retry": {
        requireNoSource();
        if (previous.status !== "failed" || event.botRunId !== null) invalid();
        status = "pending";
        botRunId = null;
        break;
      }
      case "cancelled": {
        requireNoSource();
        if (previous.status === "completed" || previous.status === "cancelled") invalid();
        status = "cancelled";
        break;
      }
    }
    if (
      event.kind !== "started" &&
      event.botRunId !== null &&
      event.botRunId !== previous.botRunId
    ) {
      invalid();
    }
    steps.set(step.id, { id: step.id, status, attempt, botRunId });
  }

  const readyStepIds = ordered
    .filter(
      (step) =>
        steps.get(step.id)?.status === "pending" &&
        step.dependsOn.every((dependency) => steps.get(dependency)?.status === "completed"),
    )
    .map((step) => step.id);
  const end = ordered.find((step) => step.kind === "end")!;
  return { steps, readyStepIds, completed: steps.get(end.id)?.status === "completed" };
};
