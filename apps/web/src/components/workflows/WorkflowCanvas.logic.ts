import type { WorkflowDefinition, WorkflowLayout } from "@t3tools/contracts";

import {
  orderWorkflowStages,
  setStageOutcomes,
  updateTask,
} from "../settings/WorkflowEditor.logic";

export type CanvasPosition = WorkflowLayout[string];

/**
 * Distance between columns: a stage node's width (`w-56`, 224px; Finish is
 * narrower) plus a gap wide enough for the vertical runs of the routes that
 * leave one stage and enter the next. Also the space kept between nodes
 * stacked in one column.
 */
export const CANVAS_COLUMN_WIDTH = 320;
export const CANVAS_ROW_GAP = 40;
const STAGE_WIDTH = 224;

/** How far a stage's first outcome row sits below its top; its incoming routes land level with it. */
const FIRST_OUTCOME_Y = 69;
const END_HEIGHT = 40;

/**
 * A node's drawn height, from what it shows: a stage's header plus one
 * single-line row per outcome, or the Finish label. Layout only needs it to
 * keep stacked nodes apart, so it errs on the tall side.
 */
export function canvasNodeHeight(definition: WorkflowDefinition, stepId: string): number {
  const step = definition.steps[stepId];
  return step?.type === "task" ? 64 + 20 * Object.keys(step.next).length : END_HEIGHT;
}

/** One outcome route of a stage, drawn as an edge from the stage's outcome handle. */
export interface WorkflowRoute {
  readonly id: string;
  readonly stepId: string;
  readonly outcome: string;
  readonly target: string;
  readonly limit: number | null;
}

// Step and outcome ids never contain ":".
export const workflowRouteId = (stepId: string, outcome: string) => `${stepId}:${outcome}`;

/**
 * Each stage's routes that point forward. Following routes from the first stage,
 * one that returns to a stage still being followed closes a revision loop and
 * goes back; every other route points forward, so the forward ones never loop.
 */
function forwardTargets(definition: WorkflowDefinition, stages: readonly string[]) {
  const targets = new Map(stages.map((id) => [id, [] as string[]]));
  const open = new Set<string>();
  const done = new Set<string>();
  const follow = (id: string) => {
    open.add(id);
    const step = definition.steps[id];
    for (const target of step?.type === "task" ? Object.values(step.next) : []) {
      if (!targets.has(target) || open.has(target)) continue;
      targets.get(id)!.push(target);
      if (!done.has(target)) follow(target);
    }
    open.delete(id);
    done.add(id);
  };
  for (const id of stages) if (!done.has(id)) follow(id);
  return targets;
}

/**
 * Steps left to right as the canvas draws them: each task stage as early as its
 * forward routes allow, ties going to the order a feature meets them, then the
 * end step. Forward routes then always point right and back routes left.
 */
export function workflowCanvasStepIds(definition: WorkflowDefinition): string[] {
  const stages = orderWorkflowStages(definition);
  const targets = forwardTargets(definition, stages);
  const waiting = new Map(stages.map((id) => [id, 0]));
  for (const list of targets.values()) {
    for (const target of list) waiting.set(target, waiting.get(target)! + 1);
  }
  const ordered: string[] = [];
  const ready = new Set(stages.filter((id) => waiting.get(id) === 0));
  while (ready.size > 0) {
    const next = stages.find((id) => ready.has(id))!;
    ready.delete(next);
    ordered.push(next);
    for (const target of targets.get(next)!) {
      const left = waiting.get(target)! - 1;
      waiting.set(target, left);
      if (left === 0) ready.add(target);
    }
  }
  return [
    ...ordered,
    ...Object.keys(definition.steps).filter((id) => definition.steps[id]?.type === "end"),
  ];
}

export function workflowRoutes(definition: WorkflowDefinition): WorkflowRoute[] {
  return orderWorkflowStages(definition).flatMap((stepId) => {
    const step = definition.steps[stepId];
    if (step?.type !== "task") return [];
    return Object.entries(step.next).map(([outcome, target]) => ({
      id: workflowRouteId(stepId, outcome),
      stepId,
      outcome,
      target,
      limit: step.limits?.[outcome] ?? null,
    }));
  });
}

/**
 * One row, left to right in canvas order, with stages top-aligned so a route
 * from a stage's first outcome to the next stage is a straight line. Finish is
 * centred on that line.
 */
export function arrangeWorkflow(definition: WorkflowDefinition): Record<string, CanvasPosition> {
  const positions: Record<string, CanvasPosition> = {};
  workflowCanvasStepIds(definition).forEach((id, column) => {
    positions[id] = {
      x: column * CANVAS_COLUMN_WIDTH,
      y: definition.steps[id]?.type === "end" ? FIRST_OUTCOME_Y - END_HEIGHT / 2 : 0,
    };
  });
  return positions;
}

/**
 * How a route is drawn, from where its target sits in canvas order:
 * - `forward` to the next step, straight across the gap between them;
 * - `skip` to a later step past others, over the row;
 * - `back` to an earlier stage, under the row into the stage's bottom;
 * - `loop` to its own stage, in a small loop under it.
 */
export type RouteKind = "forward" | "skip" | "back" | "loop";

/** Where a route runs, chosen so no two routes share a segment. */
export type RoutePlan = {
  readonly kind: RouteKind;
  /**
   * Skip routes run in lanes above the row, back routes in lanes below, and a
   * stage's loops one under another; 0 is nearest.
   */
  readonly lane: number;
  /** How far right of its stage the route turns, in pixels. */
  readonly exit: number;
  /** For a skip route, how far left of its target it drops from its lane, in pixels. */
  readonly approach: number;
  /**
   * Where the arrow lands, off the target's handle: pixels down the left edge
   * for forward and skip routes, pixels along the bottom for back routes and loops.
   */
  readonly landing: number;
};

const LANDING_STEP = 10;
const BOTTOM_LANDING_STEP = 24;
const TRACK_START = 16;
const TRACK_STEP = 10;

export function classifyRoute(
  columns: ReadonlyMap<string, number>,
  route: Pick<WorkflowRoute, "stepId" | "target">,
): RouteKind {
  if (route.target === route.stepId) return "loop";
  const from = columns.get(route.stepId);
  const to = columns.get(route.target);
  if (from === undefined || to === undefined || to === from + 1) return "forward";
  return to < from ? "back" : "skip";
}

/**
 * Packs spans into lanes: shortest first, each into the nearest lane where it
 * overlaps nothing. A short span nested in a long one then runs inside it.
 */
function assignLanes(spans: ReadonlyArray<{ id: string; from: number; to: number }>) {
  const lanes: Array<Array<{ from: number; to: number }>> = [];
  const assigned = new Map<string, number>();
  const sorted = [...spans].toSorted((a, b) => a.to - a.from - (b.to - b.from) || a.from - b.from);
  for (const span of sorted) {
    let lane = lanes.findIndex((taken) =>
      taken.every((other) => span.to < other.from || other.to < span.from),
    );
    if (lane === -1) lane = lanes.push([]) - 1;
    lanes[lane]!.push(span);
    assigned.set(span.id, lane);
  }
  return assigned;
}

/**
 * Plans every route of the workflow, keyed by route id. Positions in a lane
 * are measured in half columns: gap `g` (left of column `g`) is `2g`, and the
 * middle of column `c` is `2c + 1`. Routes in a lane overlap when their spans
 * touch, since a route leaving a gap and one arriving in it both cross it.
 */
export function planWorkflowRoutes(definition: WorkflowDefinition): Map<string, RoutePlan> {
  const columns = new Map(workflowCanvasStepIds(definition).map((id, column) => [id, column]));
  const routes = workflowRoutes(definition).map((route) => {
    const step = definition.steps[route.stepId];
    const row = step?.type === "task" ? Object.keys(step.next).indexOf(route.outcome) : 0;
    return { ...route, row, kind: classifyRoute(columns, route) };
  });
  const column = (id: string) => columns.get(id) ?? 0;
  const over = assignLanes(
    routes
      .filter((route) => route.kind === "skip")
      .map((route) => ({
        id: route.id,
        from: 2 * (column(route.stepId) + 1),
        to: 2 * column(route.target),
      })),
  );
  const under = assignLanes(
    routes
      .filter((route) => route.kind === "back")
      .map((route) => ({
        id: route.id,
        from: 2 * column(route.target) + 1,
        to: 2 * (column(route.stepId) + 1),
      })),
  );
  // A stage's loops nest: the one from the highest row turns furthest out and runs deepest.
  const loops = new Map<string, number>();
  for (const route of routes) {
    if (route.kind !== "loop") continue;
    const own = routes.filter((other) => other.kind === "loop" && other.stepId === route.stepId);
    loops.set(route.id, own.length - 1 - own.indexOf(route));
  }
  const lane = (id: string) => over.get(id) ?? under.get(id) ?? loops.get(id) ?? 0;
  // The gap right of a column holds the tracks of routes leaving that stage
  // and of skip routes dropping into the next; they are packed closer when
  // they would not otherwise fit between the two.
  const ids = [...columns.keys()];
  const trackStep = (gap: number) => {
    const leaving = routes.filter((route) => route.stepId === ids[gap]).length;
    const arriving = routes.filter(
      (route) => route.kind === "skip" && route.target === ids[gap + 1],
    ).length;
    const room = CANVAS_COLUMN_WIDTH - STAGE_WIDTH - 2 * TRACK_START;
    return Math.min(TRACK_STEP, room / Math.max(1, leaving + arriving - 1));
  };
  const goesUp = (kind: RouteKind) => kind === "forward" || kind === "skip";

  const plans = new Map<string, RoutePlan>();
  const plan = (id: string, fields: Partial<RoutePlan>) => {
    const route = routes.find((candidate) => candidate.id === id)!;
    plans.set(id, {
      kind: route.kind,
      lane: lane(id),
      exit: 0,
      approach: 0,
      landing: 0,
      ...plans.get(id),
      ...fields,
    });
  };
  // Leaving a stage, routes heading up take the nearest tracks from the top
  // row down and routes heading down the next ones from the bottom row up, so
  // a route's turn never runs along another's.
  for (const stepId of new Set(routes.map((route) => route.stepId))) {
    const own = routes.filter((route) => route.stepId === stepId);
    [
      ...own.filter((route) => goesUp(route.kind)),
      ...own.filter((route) => !goesUp(route.kind)).toReversed(),
    ].forEach((route, track) =>
      plan(route.id, { exit: TRACK_START + track * trackStep(column(stepId)) }),
    );
  }
  // Arriving on the left, only a route from the previous stage's first row
  // lands on the handle, keeping the main path straight. The rest land above
  // it, where no outcome row leaves the previous stage: skip routes highest
  // with the outermost lane on top and dropping nearest the target, then
  // forward routes by outcome row, packed closer if the target is short.
  // Arriving underneath, the deepest lane lands leftmost and loops rightmost.
  for (const target of new Set(routes.map((route) => route.target))) {
    const into = routes.filter((route) => route.target === target);
    const skips = into
      .filter((route) => route.kind === "skip")
      .toSorted((a, b) => lane(b.id) - lane(a.id));
    const step = trackStep(column(target) - 1);
    skips.forEach((route, track) => plan(route.id, { approach: TRACK_START + track * step }));
    const forwards = into
      .filter((route) => route.kind === "forward")
      .toSorted((a, b) => a.row - b.row);
    const straight = forwards[0]?.row === 0 ? forwards.slice(0, 1) : [];
    const above = [...skips, ...forwards.slice(straight.length)];
    // The handle sits level with a stage's first outcome, or mid-way down Finish.
    const room = (definition.steps[target]?.type === "end" ? END_HEIGHT / 2 : FIRST_OUTCOME_Y) - 4;
    const landingStep = Math.min(LANDING_STEP, room / Math.max(1, above.length));
    above.forEach((route, index) =>
      plan(route.id, { landing: -landingStep * (above.length - index) }),
    );
    const below = [
      ...into.filter((route) => route.kind === "back").toSorted((a, b) => lane(b.id) - lane(a.id)),
      ...into.filter((route) => route.kind === "loop").toSorted((a, b) => lane(b.id) - lane(a.id)),
    ];
    below.forEach((route, index) =>
      plan(route.id, { landing: BOTTOM_LANDING_STEP * (index - (below.length - 1) / 2) }),
    );
  }
  return plans;
}

export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

const LANE_START = 28;
const LANE_STEP = 18;
const LOOP_DROP = 10;
const LOOP_STEP = 6;

/**
 * The corners of a route, from its source handle to where its arrow lands.
 * `target` is the target's left handle for forward and skip routes and its
 * bottom handle for back routes and loops. `bounds` is the top and bottom of
 * all nodes, which the lanes run outside of.
 */
export function routePoints(
  plan: RoutePlan,
  source: CanvasPoint,
  target: CanvasPoint,
  bounds: { readonly top: number; readonly bottom: number },
): CanvasPoint[] {
  const trackX = source.x + plan.exit;
  const leave = [source, { x: trackX, y: source.y }];
  switch (plan.kind) {
    case "forward": {
      const landing = target.y + plan.landing;
      // Handles a pixel apart still read as one straight line.
      const y = Math.abs(landing - source.y) < 1 ? source.y : landing;
      return simplifyRoute([...leave, { x: trackX, y }, { x: target.x, y }]);
    }
    case "skip": {
      const laneY = bounds.top - LANE_START - plan.lane * LANE_STEP;
      const approachX = target.x - plan.approach;
      const y = target.y + plan.landing;
      return simplifyRoute([
        ...leave,
        { x: trackX, y: laneY },
        { x: approachX, y: laneY },
        { x: approachX, y },
        { x: target.x, y },
      ]);
    }
    case "back":
    case "loop": {
      const laneY =
        plan.kind === "loop"
          ? target.y + LOOP_DROP + plan.lane * LOOP_STEP
          : bounds.bottom + LANE_START + plan.lane * LANE_STEP;
      const x = target.x + plan.landing;
      return simplifyRoute([
        ...leave,
        { x: trackX, y: laneY },
        { x, y: laneY },
        { x, y: target.y },
      ]);
    }
  }
}

/** Drops repeated points and the middle of three in a line. */
function simplifyRoute(points: readonly CanvasPoint[]): CanvasPoint[] {
  const kept: CanvasPoint[] = [];
  for (const point of points) {
    const last = kept.at(-1);
    if (last && last.x === point.x && last.y === point.y) continue;
    const before = kept.at(-2);
    if (
      before &&
      last &&
      ((before.x === last.x && last.x === point.x) || (before.y === last.y && last.y === point.y))
    ) {
      kept[kept.length - 1] = point;
    } else {
      kept.push(point);
    }
  }
  return kept;
}

/** An SVG path through `points` with each corner rounded. */
export function routePath(points: readonly CanvasPoint[], radius = 8): string {
  const [first, ...rest] = points;
  if (!first) return "";
  const toward = (from: number, to: number, distance: number) =>
    from + Math.sign(to - from) * distance;
  let path = `M ${first.x} ${first.y}`;
  rest.forEach((point, index) => {
    const before = points[index]!;
    const after = rest[index + 1];
    if (!after) {
      path += ` L ${point.x} ${point.y}`;
      return;
    }
    const length = (a: CanvasPoint, b: CanvasPoint) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const r = Math.min(radius, length(before, point) / 2, length(point, after) / 2);
    path += ` L ${toward(point.x, before.x, r)} ${toward(point.y, before.y, r)}`;
    path += ` Q ${point.x} ${point.y} ${toward(point.x, after.x, r)} ${toward(point.y, after.y, r)}`;
  });
  return path;
}

/** Where a route's label goes: the middle of its longest horizontal run, which is its lane if it has one. */
export function routeLabelPoint(points: readonly CanvasPoint[]): CanvasPoint {
  let best = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0, length: -1 };
  points.slice(1).forEach((point, index) => {
    const before = points[index]!;
    const length = Math.abs(point.x - before.x);
    if (before.y === point.y && length > best.length) {
      best = { x: (point.x + before.x) / 2, y: point.y, length };
    }
  });
  return { x: best.x, y: best.y };
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
  const auto = arrangeWorkflow(definition);
  if (!ids.some((id) => Object.hasOwn(layout, id))) return auto;

  const placed: Record<string, CanvasPosition> = {};
  for (const id of ids) {
    const saved = layout[id];
    if (saved) placed[id] = saved;
  }
  // The placed node a candidate would overlap: closer than a column apart
  // sideways, and without a row gap between them vertically.
  const overlapping = (id: string, candidate: CanvasPosition) => {
    const height = canvasNodeHeight(definition, id);
    return Object.entries(placed).find(
      ([otherId, other]) =>
        Math.abs(other.x - candidate.x) < CANVAS_COLUMN_WIDTH &&
        candidate.y < other.y + canvasNodeHeight(definition, otherId) + CANVAS_ROW_GAP &&
        other.y < candidate.y + height + CANVAS_ROW_GAP,
    );
  };
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
    for (let hit = overlapping(id, candidate); hit; hit = overlapping(id, candidate)) {
      const [otherId, other] = hit;
      candidate = {
        x: candidate.x,
        y: other.y + canvasNodeHeight(definition, otherId) + CANVAS_ROW_GAP,
      };
    }
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
