import type { WorkflowDefinition, WorkflowLayout } from "@t3tools/contracts";

import {
  orderWorkflowStages,
  setStageOutcomes,
  updateTask,
} from "../settings/WorkflowEditor.logic";

export type CanvasPosition = WorkflowLayout[string];

/** Spacing of placed stages, sized for a stage node with a few outcomes. */
export const CANVAS_COLUMN_WIDTH = 300;
export const CANVAS_ROW_HEIGHT = 170;

/** One outcome route of a stage, drawn as an edge from the stage's outcome handle. */
export interface WorkflowRoute {
  readonly id: string;
  readonly stepId: string;
  readonly outcome: string;
  readonly target: string;
  readonly limit: number | null;
}

/** Task stages in feature order, then the end step, which is how the canvas lists its nodes. */
export function workflowCanvasStepIds(definition: WorkflowDefinition): string[] {
  return [
    ...orderWorkflowStages(definition),
    ...Object.keys(definition.steps).filter((id) => definition.steps[id]?.type === "end"),
  ];
}

export function workflowRoutes(definition: WorkflowDefinition): WorkflowRoute[] {
  return orderWorkflowStages(definition).flatMap((stepId) => {
    const step = definition.steps[stepId];
    if (step?.type !== "task") return [];
    return Object.entries(step.next).map(([outcome, target]) => ({
      // Step and outcome ids never contain ":".
      id: `${stepId}:${outcome}`,
      stepId,
      outcome,
      target,
      limit: step.limits?.[outcome] ?? null,
    }));
  });
}

/**
 * Columns by distance from the first stage, each centred on y = 0. Stages
 * nothing routes to get a column after the reachable ones, and the end step
 * always sits in the last column.
 */
export function autoLayoutWorkflow(definition: WorkflowDefinition): Record<string, CanvasPosition> {
  const depth = new Map<string, number>();
  if (definition.steps[definition.start]?.type === "task") depth.set(definition.start, 0);
  const queue = [...depth.keys()];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const step = definition.steps[id];
    if (step?.type !== "task") continue;
    for (const target of Object.values(step.next)) {
      if (definition.steps[target]?.type !== "task" || depth.has(target)) continue;
      depth.set(target, depth.get(id)! + 1);
      queue.push(target);
    }
  }
  const reachableColumns = depth.size === 0 ? 0 : Math.max(...depth.values()) + 1;
  const stages = orderWorkflowStages(definition);
  const unreachable = stages.some((id) => !depth.has(id));
  const endColumn = reachableColumns + (unreachable ? 1 : 0);

  const columns: string[][] = [];
  for (const id of workflowCanvasStepIds(definition)) {
    const column =
      definition.steps[id]?.type === "end" ? endColumn : (depth.get(id) ?? reachableColumns);
    (columns[column] ??= []).push(id);
  }
  const positions: Record<string, CanvasPosition> = {};
  columns.forEach((ids, column) => {
    ids.forEach((id, row) => {
      positions[id] = {
        x: column * CANVAS_COLUMN_WIDTH,
        y: (row - (ids.length - 1) / 2) * CANVAS_ROW_HEIGHT,
      };
    });
  });
  return positions;
}

/**
 * Where each node is drawn. Without a saved layout the whole graph is laid out
 * automatically. Once positions are saved, a step without one (say, a stage
 * just added in the form) goes to the right of a stage that routes to it,
 * moved down until it no longer overlaps another node.
 */
export function workflowNodePositions(
  definition: WorkflowDefinition,
): Record<string, CanvasPosition> {
  const ids = workflowCanvasStepIds(definition);
  const layout = definition.layout ?? {};
  const auto = autoLayoutWorkflow(definition);
  if (!ids.some((id) => Object.hasOwn(layout, id))) return auto;

  const placed: Record<string, CanvasPosition> = {};
  for (const id of ids) {
    const saved = layout[id];
    if (saved) placed[id] = saved;
  }
  const overlaps = (candidate: CanvasPosition) =>
    Object.values(placed).some(
      (other) =>
        Math.abs(other.x - candidate.x) < CANVAS_COLUMN_WIDTH / 2 &&
        Math.abs(other.y - candidate.y) < CANVAS_ROW_HEIGHT / 2,
    );
  for (const id of ids) {
    if (placed[id]) continue;
    const from = ids.find((source) => {
      const step = definition.steps[source];
      return (
        placed[source] !== undefined &&
        step?.type === "task" &&
        Object.values(step.next).includes(id)
      );
    });
    const origin = from ? placed[from]! : auto[id]!;
    let candidate = from ? { x: origin.x + CANVAS_COLUMN_WIDTH, y: origin.y } : origin;
    while (overlaps(candidate)) candidate = { x: candidate.x, y: candidate.y + CANVAS_ROW_HEIGHT };
    placed[id] = candidate;
  }
  return placed;
}

/**
 * Saves where every node is drawn. Positions are whole pixels so a nudge back
 * to the same spot reads as no edit; an unchanged layout returns `definition`.
 */
export function withNodePositions(
  definition: WorkflowDefinition,
  positions: Readonly<Record<string, CanvasPosition>>,
): WorkflowDefinition {
  const layout: Record<string, CanvasPosition> = {};
  for (const id of workflowCanvasStepIds(definition)) {
    const position = positions[id];
    if (position) layout[id] = { x: Math.round(position.x), y: Math.round(position.y) };
  }
  const current = definition.layout ?? {};
  const unchanged =
    Object.keys(layout).length === Object.keys(current).length &&
    Object.entries(layout).every(
      ([id, position]) => current[id]?.x === position.x && current[id]?.y === position.y,
    );
  return unchanged ? definition : { ...definition, layout };
}

/** Points a stage's outcome at another step. Routing a stage to itself is not offered. */
export function connectRoute(
  definition: WorkflowDefinition,
  stepId: string,
  outcome: string,
  target: string,
): WorkflowDefinition {
  if (target === stepId || !Object.hasOwn(definition.steps, target)) return definition;
  return updateTask(definition, stepId, (step) =>
    Object.hasOwn(step.next, outcome)
      ? { ...step, next: { ...step.next, [outcome]: target } }
      : step,
  );
}

/** A route goes with its outcome, so a stage keeps at least one. */
export function canRemoveRoute(definition: WorkflowDefinition, stepId: string): boolean {
  const step = definition.steps[stepId];
  return step?.type === "task" && Object.keys(step.next).length > 1;
}

export function removeRoute(
  definition: WorkflowDefinition,
  stepId: string,
  outcome: string,
): WorkflowDefinition {
  const step = definition.steps[stepId];
  if (step?.type !== "task" || !canRemoveRoute(definition, stepId)) return definition;
  return setStageOutcomes(
    definition,
    stepId,
    Object.keys(step.next).filter((candidate) => candidate !== outcome),
  );
}

/** Other stages with a route to `stepId`, which keep it from being removed. */
export function stagesRoutingTo(definition: WorkflowDefinition, stepId: string): string[] {
  return orderWorkflowStages(definition).filter((id) => {
    const step = definition.steps[id];
    return id !== stepId && step?.type === "task" && Object.values(step.next).includes(stepId);
  });
}
