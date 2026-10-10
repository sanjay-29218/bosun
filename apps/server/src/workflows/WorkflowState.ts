import {
  workflowForwardOutcome,
  type FeatureCardState,
  type ModelSelection,
  type ThreadId,
  type WorkflowDefinition,
  type WorkflowStagePosition,
  type WorkflowStepEvent,
  type WorkflowYourCall,
} from "@t3tools/contracts";

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
  | "cancelled"
  | "awaiting-approval"
  | "limit-reached"
  | "taken-over"
  | "skipped";

export interface WorkflowStepState {
  readonly id: string;
  readonly status: WorkflowStepStatus;
  readonly executionId: string | null;
  readonly attempt: number;
  readonly botRunId: string | null;
  readonly outcome: string | null;
  /** The outcome a gate or route limit holds until a person decides. */
  readonly pendingOutcome: string | null;
  /** A Retry override that applies to the rest of this execution. */
  readonly modelSelection: ModelSelection | null;
  /** A person's existing thread, attached as this stage's thread instead of a bot run. */
  readonly threadId: ThreadId | null;
}

export interface WorkflowState {
  readonly steps: ReadonlyMap<string, WorkflowStepState>;
  readonly readyStepIds: ReadonlyArray<string>;
  readonly activeStepId: string | null;
  /** The stage a cancelled feature stopped at; reopen resumes there. */
  readonly stoppedStepId: string | null;
  readonly executionCount: number;
  readonly completed: boolean;
  readonly cancelled: boolean;
  readonly paused: boolean;
  readonly yourCall: WorkflowYourCall | null;
}

const nonEmpty = (value: string | null | undefined, max: number) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

const freshStep = (id: string): WorkflowStepState => ({
  id,
  status: "pending",
  executionId: null,
  attempt: 0,
  botRunId: null,
  outcome: null,
  pendingOutcome: null,
  modelSelection: null,
  threadId: null,
});

/** Steps reachable from `stepId` through outcome routes, including itself. */
const reachableFrom = (definition: WorkflowDefinition, stepId: string) => {
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const step = definition.steps[id];
    if (step?.type === "task") Object.values(step.next).forEach(visit);
  };
  visit(stepId);
  return reachable;
};

export const defaultForwardOutcome = workflowForwardOutcome;

/**
 * Replays the active path; every rework execution remains in the durable event history.
 * Bots drive started/completed/question/answered/failed through verified handoff receipts.
 * Every other kind is a person's (or the workflow's own) decision, and each stuck state has
 * one: failed → retry/take over/send back/skip, awaiting-approval → approve/request changes,
 * limit-reached → accept/one more round/take over, taken-over → mark done/retry,
 * cancelled and done → reopen. An `attached` stage is a person's own thread: it starts
 * taken over, and the workflow completes it when that thread's turn finishes.
 */
export const projectWorkflowState = (
  definition: WorkflowDefinition,
  events: ReadonlyArray<WorkflowStepEvent>,
): WorkflowState => {
  validateWorkflowDefinition(definition);
  if (events.length > 4096) throw new WorkflowTransitionError("Workflow history is too large");
  const steps = new Map<string, WorkflowStepState>(
    Object.keys(definition.steps).map((id) => [id, freshStep(id)]),
  );
  const eventIds = new Set<string>();
  const executionIds = new Set<string>();
  const usedRunIds = new Set<string>();
  const routeCounts = new Map<string, number>();
  const routeExtensions = new Map<string, number>();
  let extraExecutions = 0;
  let activeStepId: string | null = definition.start;
  let stoppedStepId: string | null = null;
  let executionCount = 0;
  let completed = false;
  let cancelled = false;
  let paused = false;
  let yourCall: WorkflowYourCall | null = null;

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
    if (!step || !previous || step.type !== "task") return invalid();
    if (event.kind === "reopened") {
      if (!completed && !cancelled) invalid();
    } else if (activeStepId !== event.stepId || completed || cancelled) {
      invalid();
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
    const statusIn = (...statuses: ReadonlyArray<WorkflowStepStatus>) => {
      if (!statuses.includes(previous.status)) invalid();
    };
    const carriesOutcome = ["completed", "marked-done", "skipped", "accepted"].includes(event.kind);
    if (!carriesOutcome && event.outcome !== null) invalid();
    if (event.kind !== "started" && event.botRunId !== null && event.botRunId !== previous.botRunId)
      invalid();
    if (event.kind !== "sent-back" && event.targetStepId !== undefined) invalid();
    if (event.kind !== "retry" && event.modelSelection !== undefined) invalid();
    if (event.kind !== "attached" && event.threadId !== undefined) invalid();
    const attachedStage =
      previous.status === "taken-over" && previous.threadId !== null && previous.botRunId === null;

    /** Leaves `from` with `outcome`, or holds it at Your call when a limit is used up. */
    const route = (from: WorkflowStepState, outcome: string, checkLimits: boolean) => {
      let target: string;
      try {
        target = nextWorkflowStep(definition, from.id, outcome);
      } catch {
        return invalid();
      }
      const routeKey = `${from.id}\0${outcome}`;
      const limit = step.limits?.[outcome];
      const taken = routeCounts.get(routeKey) ?? 0;
      const reason = !checkLimits
        ? null
        : limit !== undefined && taken >= limit + (routeExtensions.get(routeKey) ?? 0)
          ? ("loop-limit" as const)
          : definition.steps[target]?.type === "task" &&
              executionCount >= definition.defaults.maxStepExecutions + extraExecutions
            ? ("execution-limit" as const)
            : null;
      if (reason) {
        steps.set(from.id, { ...from, status: "limit-reached", pendingOutcome: outcome });
        yourCall = { reason, stepId: from.id, outcome, target };
        return;
      }
      routeCounts.set(routeKey, taken + 1);
      yourCall = null;
      steps.set(from.id, { ...from, outcome, pendingOutcome: null });
      if (definition.steps[target]?.type === "end") {
        steps.set(target, { ...freshStep(target), status: "completed" });
        completed = true;
        activeStepId = null;
      } else {
        steps.set(target, freshStep(target));
        activeStepId = target;
      }
    };
    /** Resets `target` and everything after it, then makes it the active stage. */
    const restartAt = (target: string) => {
      for (const id of reachableFrom(definition, target)) steps.set(id, freshStep(id));
      activeStepId = target;
      yourCall = null;
    };

    switch (event.kind) {
      case "paused":
      case "resumed": {
        noSource();
        if (
          event.executionId !== previous.executionId ||
          event.botRunId !== null ||
          (event.kind === "paused" ? paused : !paused)
        )
          invalid();
        paused = event.kind === "paused";
        continue;
      }
      case "started": {
        handoffSource();
        if (
          paused ||
          previous.status !== "pending" ||
          !nonEmpty(event.botRunId, 128) ||
          !nonEmpty(event.executionId, 128)
        )
          invalid();
        if (usedRunIds.has(event.botRunId!)) invalid();
        if (previous.executionId === null) {
          if (executionIds.has(event.executionId!)) invalid();
          executionIds.add(event.executionId!);
          executionCount++;
        } else {
          sameExecution();
        }
        usedRunIds.add(event.botRunId!);
        steps.set(event.stepId, {
          ...previous,
          status: "running",
          executionId: event.executionId,
          attempt: previous.attempt + 1,
          botRunId: event.botRunId,
          outcome: null,
        });
        continue;
      }
      case "attached": {
        noSource();
        if (
          paused ||
          previous.status !== "pending" ||
          previous.executionId !== null ||
          event.botRunId !== null ||
          !nonEmpty(event.executionId, 128) ||
          !nonEmpty(event.threadId, 128)
        )
          invalid();
        if (executionIds.has(event.executionId!)) invalid();
        executionIds.add(event.executionId!);
        executionCount++;
        steps.set(event.stepId, {
          ...previous,
          status: "taken-over",
          executionId: event.executionId,
          attempt: previous.attempt + 1,
          threadId: event.threadId!,
          outcome: null,
        });
        continue;
      }
      case "completed": {
        sameExecution();
        // An attached stage completes from its thread's finished turn, cited by run ID.
        if (
          (attachedStage
            ? event.sourceKind !== "workflow"
            : previous.status !== "running" || event.sourceKind !== "handoff") ||
          !nonEmpty(event.sourceId, 128) ||
          !nonEmpty(event.outcome, 80) ||
          !nonEmpty(event.detail, 16_000) ||
          !Object.hasOwn(step.next, event.outcome!)
        )
          invalid();
        if (step.gate) {
          steps.set(event.stepId, {
            ...previous,
            status: "awaiting-approval",
            outcome: event.outcome,
            pendingOutcome: event.outcome,
          });
        } else {
          route({ ...previous, status: "completed" }, event.outcome!, true);
        }
        continue;
      }
      case "question": {
        handoffSource();
        sameExecution();
        if (previous.status !== "running" || !nonEmpty(event.detail, 16_000)) invalid();
        steps.set(event.stepId, { ...previous, status: "needs-input" });
        continue;
      }
      case "answered": {
        if (
          (event.sourceKind !== "handoff" && event.sourceKind !== "decision") ||
          !nonEmpty(event.sourceId, 128)
        )
          invalid();
        sameExecution();
        if (previous.status !== "needs-input" || !nonEmpty(event.detail, 16_000)) invalid();
        steps.set(event.stepId, { ...previous, status: "running" });
        continue;
      }
      case "failed": {
        if (
          (event.sourceKind !== "handoff" && event.sourceKind !== "workflow") ||
          !nonEmpty(event.sourceId, 128)
        )
          invalid();
        sameExecution();
        statusIn("running", "needs-input");
        if (!nonEmpty(event.detail, 16_000)) invalid();
        steps.set(event.stepId, { ...previous, status: "failed" });
        continue;
      }
      case "retry": {
        // A person may always retry; the workflow's own retries cite the failure they answer.
        if (event.sourceKind === "workflow") {
          if (!nonEmpty(event.sourceId, 128) || previous.status !== "failed") invalid();
        } else {
          noSource();
          statusIn("failed", "taken-over");
        }
        sameExecution();
        if (event.botRunId !== null) invalid();
        // Retrying an attached stage hands it to the stage's bot.
        steps.set(event.stepId, {
          ...previous,
          status: "pending",
          botRunId: null,
          threadId: null,
          modelSelection: event.modelSelection ?? previous.modelSelection,
        });
        continue;
      }
      case "cancelled": {
        noSource();
        if (previous.status === "pending" && previous.executionId === null) {
          if (event.executionId !== null || event.botRunId !== null) invalid();
        } else {
          sameExecution();
        }
        steps.set(event.stepId, { ...previous, status: "cancelled" });
        cancelled = true;
        stoppedStepId = event.stepId;
        activeStepId = null;
        yourCall = null;
        continue;
      }
      case "approved": {
        noSource();
        sameExecution();
        statusIn("awaiting-approval");
        route({ ...previous, status: "completed" }, previous.pendingOutcome!, true);
        continue;
      }
      case "changes-requested": {
        noSource();
        sameExecution();
        statusIn("awaiting-approval");
        if (!nonEmpty(event.detail, 16_000)) invalid();
        // The stage reruns as a new execution with the note.
        steps.set(event.stepId, freshStep(event.stepId));
        continue;
      }
      case "taken-over": {
        noSource();
        sameExecution();
        statusIn("running", "needs-input", "failed", "awaiting-approval", "limit-reached");
        steps.set(event.stepId, { ...previous, status: "taken-over", pendingOutcome: null });
        yourCall = null;
        continue;
      }
      case "marked-done": {
        noSource();
        sameExecution();
        statusIn("taken-over");
        if (!nonEmpty(event.outcome, 80) || !nonEmpty(event.detail, 16_000)) invalid();
        route({ ...previous, status: "completed" }, event.outcome!, false);
        continue;
      }
      case "skipped": {
        noSource();
        if (event.executionId !== previous.executionId) invalid();
        statusIn("pending", "failed", "limit-reached");
        if (!nonEmpty(event.outcome, 80)) invalid();
        route({ ...previous, status: "skipped" }, event.outcome!, false);
        continue;
      }
      case "accepted": {
        noSource();
        sameExecution();
        statusIn("limit-reached");
        if (!nonEmpty(event.outcome, 80)) invalid();
        route({ ...previous, status: "completed" }, event.outcome!, false);
        continue;
      }
      case "extended": {
        noSource();
        sameExecution();
        statusIn("limit-reached");
        const held = yourCall!;
        if (held.reason === "loop-limit") {
          const routeKey = `${held.stepId}\0${held.outcome}`;
          routeExtensions.set(routeKey, (routeExtensions.get(routeKey) ?? 0) + 1);
        } else {
          extraExecutions++;
        }
        route({ ...previous, status: "completed" }, previous.pendingOutcome!, true);
        continue;
      }
      case "sent-back": {
        noSource();
        if (event.executionId !== previous.executionId) invalid();
        statusIn("failed", "limit-reached", "awaiting-approval", "taken-over");
        const target = event.targetStepId;
        const targetState = target === undefined ? undefined : steps.get(target);
        if (
          target === undefined ||
          target === event.stepId ||
          definition.steps[target]?.type !== "task" ||
          (targetState?.status !== "completed" && targetState?.status !== "skipped")
        )
          invalid();
        restartAt(target!);
        continue;
      }
      case "reopened": {
        noSource();
        if (event.executionId !== null) invalid();
        if (cancelled) {
          // Resume where it stopped; an interrupted attempt restarts within its execution,
          // and an attached thread becomes the stage's thread again.
          if (event.stepId !== stoppedStepId) invalid();
          const reattach = previous.threadId !== null && previous.botRunId === null;
          steps.set(event.stepId, {
            ...previous,
            status: reattach ? "taken-over" : "pending",
            botRunId: null,
            pendingOutcome: null,
          });
          activeStepId = event.stepId;
          cancelled = false;
          stoppedStepId = null;
        } else {
          // A follow-up from Done restarts at the chosen stage; every stage leads to the end.
          completed = false;
          restartAt(event.stepId);
        }
        continue;
      }
    }
  }

  return {
    steps,
    readyStepIds:
      !paused && activeStepId !== null && steps.get(activeStepId)?.status === "pending"
        ? [activeStepId]
        : [],
    activeStepId,
    stoppedStepId,
    executionCount,
    completed,
    cancelled,
    paused,
    yourCall,
  };
};

/** The board column, by precedence: what needs a person outranks what is merely waiting. */
export const featureCardState = (state: WorkflowState, queued: boolean): FeatureCardState => {
  if (state.cancelled) return "cancelled";
  if (state.completed) return "done";
  const status = state.activeStepId ? state.steps.get(state.activeStepId)?.status : undefined;
  if (status === "limit-reached") return "your-call";
  if (status === "failed") return "failed";
  if (status === "awaiting-approval") return "approval";
  if (status === "needs-input") return "input";
  if (state.paused) return "paused";
  if (queued) return "queued";
  return "working";
};

/** The stage a feature is at among its task steps, counted from 1 in definition order. */
export const featureStage = (
  definition: WorkflowDefinition,
  state: WorkflowState,
): WorkflowStagePosition | null =>
  stagePosition(definition, state.activeStepId ?? state.stoppedStepId);

export const stagePosition = (
  definition: WorkflowDefinition,
  stepId: string | null,
): WorkflowStagePosition | null => {
  if (stepId === null) return null;
  const tasks = Object.keys(definition.steps).filter((id) => definition.steps[id]?.type === "task");
  const index = tasks.indexOf(stepId);
  return index < 0 ? null : { stepId, index: index + 1, total: tasks.length };
};
