import type { WorkflowDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { removeStage } from "../library/WorkflowEditor.logic";
import {
  CANVAS_COLUMN_WIDTH,
  CANVAS_ROW_GAP,
  arrangeWorkflow,
  canRemoveRoute,
  canvasNodeHeight,
  connectRoute,
  planWorkflowRoutes,
  removeRoute,
  routeLabelPoint,
  routePath,
  routePoints,
  stagesRoutingTo,
  withNodePositions,
  workflowCanvasStepIds,
  workflowNodePositions,
  workflowRoutes,
  type CanvasPoint,
} from "./WorkflowCanvas.logic";

function workflow(): WorkflowDefinition {
  return {
    schemaVersion: 2,
    id: "feature-delivery",
    name: "Feature delivery",
    revision: 1,
    start: "plan",
    roles: {
      builder: { roleId: "builder", roleRevision: 1, supervisor: null },
    },
    steps: {
      plan: { type: "task", role: "builder", task: "Plan", next: { ready: "build", fail: "end" } },
      build: { type: "task", role: "builder", task: "Build", next: { built: "review" } },
      review: {
        type: "task",
        role: "builder",
        task: "Review",
        next: { approved: "end", changes_requested: "build" },
        limits: { changes_requested: 3 },
      },
      orphan: { type: "task", role: "builder", task: "Unused", next: { done: "end" } },
      end: { type: "end" },
    },
    defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
  };
}

/** The starter workflow's shape: a straight path with change requests looping back through a decision. */
function starter(): WorkflowDefinition {
  const task = (next: Record<string, string>) =>
    ({ type: "task", role: "builder", task: "Do it", next }) as const;
  return {
    ...workflow(),
    steps: {
      plan: task({ ready: "design" }),
      design: task({ ready: "build" }),
      build: task({ built: "qa", design_change_requested: "change_review" }),
      qa: task({ passed: "review", changes_requested: "change_review" }),
      review: {
        ...task({ approved: "end", changes_requested: "change_review" }),
        limits: { changes_requested: 3 },
      },
      change_review: task({ revise_design: "design", revise_build: "build" }),
      end: { type: "end" },
    },
  };
}

const column = (n: number) => n * CANVAS_COLUMN_WIDTH;

describe("workflowRoutes", () => {
  it("lists one edge per outcome with its limit, in feature order", () => {
    expect(
      workflowRoutes(workflow()).map((route) => [route.id, route.target, route.limit]),
    ).toEqual([
      ["plan:ready", "build", null],
      ["plan:fail", "end", null],
      ["build:built", "review", null],
      ["review:approved", "end", null],
      ["review:changes_requested", "build", 3],
      ["orphan:done", "end", null],
    ]);
  });
});

describe("workflowCanvasStepIds", () => {
  it("orders stages so every forward route points right, then Finish", () => {
    expect(workflowCanvasStepIds(starter())).toEqual([
      "plan",
      "design",
      "build",
      "qa",
      "review",
      "change_review",
      "end",
    ]);
    // An unreachable stage comes after the reachable ones.
    expect(workflowCanvasStepIds(workflow())).toEqual(["plan", "build", "review", "orphan", "end"]);
  });
});

describe("arrangeWorkflow", () => {
  it("puts every step in one row, left to right in canvas order, with Finish level with first outcomes", () => {
    const definition = workflow();
    const positions = arrangeWorkflow(definition);
    expect(positions.plan).toEqual({ x: column(0), y: 0 });
    expect(positions.build).toEqual({ x: column(1), y: 0 });
    expect(positions.review).toEqual({ x: column(2), y: 0 });
    expect(positions.orphan).toEqual({ x: column(3), y: 0 });
    expect(positions.end!.x).toBe(column(4));
    expect(positions.end!.y).toBeGreaterThan(0);
  });
});

describe("planWorkflowRoutes", () => {
  it("tells forward routes from ones that skip ahead, go back, or loop", () => {
    const plans = planWorkflowRoutes(starter());
    const kinds = Object.fromEntries([...plans].map(([id, plan]) => [id, plan.kind]));
    expect(kinds).toEqual({
      "plan:ready": "forward",
      "design:ready": "forward",
      "build:built": "forward",
      "build:design_change_requested": "skip",
      "qa:passed": "forward",
      "qa:changes_requested": "skip",
      "review:approved": "skip",
      "review:changes_requested": "forward",
      "change_review:revise_design": "back",
      "change_review:revise_build": "back",
    });
    const looped: WorkflowDefinition = {
      ...workflow(),
      steps: {
        ...workflow().steps,
        build: { type: "task", role: "builder", task: "Build", next: { again: "build" } },
      },
    };
    expect(planWorkflowRoutes(looped).get("build:again")?.kind).toBe("loop");
  });

  it("gives overlapping lanes their own depth, the shorter one nearest the row", () => {
    const plans = planWorkflowRoutes(starter());
    const lane = (id: string) => plans.get(id)!.lane;
    // Back routes from Change review: to Build (shorter, nearer) and to Design (deeper).
    expect(lane("change_review:revise_build")).toBe(0);
    expect(lane("change_review:revise_design")).toBe(1);
    // Over the row, Review → Finish and QA → Change review share a gap, so they cannot share a lane.
    const over = ["build:design_change_requested", "qa:changes_requested", "review:approved"];
    expect(new Set(over.map(lane)).size).toBe(3);
  });

  it("lands only the first-row route from the previous stage on the handle", () => {
    const plans = planWorkflowRoutes(starter());
    expect(plans.get("plan:ready")!.landing).toBe(0);
    // Change review is entered by two skip routes and from Review's second row, all above the handle.
    expect(plans.get("review:changes_requested")!.landing).toBe(-10);
    const skips = ["build:design_change_requested", "qa:changes_requested"].map((id) =>
      plans.get(id)!,
    );
    // The outer lane drops nearest the target and lands highest.
    const [outer, inner] = skips.toSorted((a, b) => b.lane - a.lane);
    expect(outer!.landing).toBe(-30);
    expect(inner!.landing).toBe(-20);
    expect(outer!.approach).toBeLessThan(inner!.approach);
  });
});

/**
 * Each route of the arranged workflow as segments, from where React Flow puts
 * handles: outcome rows 20px apart from the first at y + 69 on the right, the
 * incoming handle level with the first row on the left, and one under the middle.
 */
function arrangedRoutes(definition: WorkflowDefinition) {
  const positions = arrangeWorkflow(definition);
  const box = (id: string) => {
    const { x, y } = positions[id]!;
    const end = definition.steps[id]?.type === "end";
    return { x, y, width: end ? 80 : 224, height: canvasNodeHeight(definition, id) - 1, end };
  };
  const boxes = workflowCanvasStepIds(definition).map(box);
  const bounds = {
    top: Math.min(...boxes.map((node) => node.y)),
    bottom: Math.max(...boxes.map((node) => node.y + node.height)),
  };
  const plans = planWorkflowRoutes(definition);
  const routes = workflowRoutes(definition).map((route) => {
    const into = box(route.target);
    const plan = plans.get(route.id)!;
    const from = box(route.stepId);
    const to = box(route.target);
    const step = definition.steps[route.stepId];
    const row = step?.type === "task" ? Object.keys(step.next).indexOf(route.outcome) : 0;
    const source = { x: from.x + from.width, y: from.y + 69 + 20 * row };
    const target =
      plan.kind === "back" || plan.kind === "loop"
        ? { x: to.x + to.width / 2, y: to.y + to.height }
        : { x: to.x, y: to.end ? to.y + to.height / 2 : to.y + 69 };
    return { id: route.id, into, points: routePoints(plan, source, target, bounds) };
  });
  return { boxes, routes };
}

type Segment = readonly [CanvasPoint, CanvasPoint];
const segments = (points: readonly CanvasPoint[]): Segment[] =>
  points.slice(1).map((point, index) => [points[index]!, point] as const);
const span = (a: number, b: number) => [Math.min(a, b), Math.max(a, b)] as const;

function sharesRun(a: Segment, b: Segment) {
  for (const axis of ["x", "y"] as const) {
    const along = axis === "x" ? "y" : "x";
    if (a[0][axis] === a[1][axis] && b[0][axis] === b[1][axis] && a[0][axis] === b[0][axis]) {
      const [aLow, aHigh] = span(a[0][along], a[1][along]);
      const [bLow, bHigh] = span(b[0][along], b[1][along]);
      if (Math.min(aHigh, bHigh) - Math.max(aLow, bLow) > 0) return true;
    }
  }
  return false;
}

function crossesBody(
  segment: Segment,
  node: { x: number; y: number; width: number; height: number },
) {
  const [left, right] = span(segment[0].x, segment[1].x);
  const [top, bottom] = span(segment[0].y, segment[1].y);
  return (
    left < node.x + node.width - 1 &&
    right > node.x + 1 &&
    top < node.y + node.height - 1 &&
    bottom > node.y + 1
  );
}

describe("routePoints on an arranged workflow", () => {
  const task = (next: Record<string, string>) =>
    ({ type: "task", role: "builder", task: "Do it", next }) as const;
  // Ten stages in a chain that can each also finish early, which crowds the gap before Finish.
  const chain = Array.from({ length: 10 }, (_, index) => `s${index}`);
  const crowded: WorkflowDefinition = {
    ...workflow(),
    start: "s0",
    steps: {
      ...Object.fromEntries(
        chain.map((id, index) => [id, task({ next: chain[index + 1] ?? "end", stop: "end" })]),
      ),
      end: { type: "end" },
    },
  };
  it.each([
    ["the starter workflow", starter()],
    ["a workflow with an unreachable stage", workflow()],
    [
      "a stage routing three outcomes to a short next stage",
      {
        ...workflow(),
        steps: {
          plan: task({ a: "build", b: "build", c: "build" }),
          build: task({ done: "end" }),
          end: { type: "end" },
        },
      } satisfies WorkflowDefinition,
    ],
    [
      "a stage with two loops",
      {
        ...workflow(),
        steps: {
          plan: task({ done: "end", retry: "plan", rework: "plan" }),
          end: { type: "end" },
        },
      } satisfies WorkflowDefinition,
    ],
    ["a crowded Finish", crowded],
  ] as const)("keeps routes off node bodies and off each other in %s", (_, definition) => {
    const { boxes, routes } = arrangedRoutes(definition);
    for (const route of routes) {
      // The arrow lands on its target's edge.
      const end = route.points.at(-1)!;
      expect(end.x, route.id).toBeGreaterThanOrEqual(route.into.x);
      expect(end.x, route.id).toBeLessThanOrEqual(route.into.x + route.into.width);
      expect(end.y, route.id).toBeGreaterThanOrEqual(route.into.y);
      expect(end.y, route.id).toBeLessThanOrEqual(route.into.y + route.into.height);
      for (const segment of segments(route.points)) {
        for (const node of boxes) expect(crossesBody(segment, node), route.id).toBe(false);
      }
    }
    routes.forEach((route, index) => {
      for (const other of routes.slice(index + 1)) {
        const shared = segments(route.points).some((a) =>
          segments(other.points).some((b) => sharesRun(a, b)),
        );
        expect(shared, `${route.id} and ${other.id}`).toBe(false);
      }
    });
  });

  it("draws the main path as straight lines and runs back routes under the row", () => {
    const { boxes, routes } = arrangedRoutes(starter());
    const points = (id: string) => routes.find((route) => route.id === id)!.points;
    expect(points("plan:ready")).toHaveLength(2);
    expect(points("build:built")).toHaveLength(2);
    const bottom = Math.max(...boxes.map((node) => node.y + node.height));
    const back = points("change_review:revise_design");
    expect(Math.max(...back.map((point) => point.y))).toBeGreaterThan(bottom);
    // It arrives from below, so the last run points up.
    expect(back.at(-1)!.y).toBeLessThan(back.at(-2)!.y);
  });

  it("puts a limit label on the lane of a route that has one", () => {
    const { boxes, routes } = arrangedRoutes(workflow());
    const back = routes.find((route) => route.id === "review:changes_requested")!.points;
    const label = routeLabelPoint(back);
    expect(label.y).toBeGreaterThan(Math.max(...boxes.map((node) => node.y + node.height)));
  });
});

describe("routePath", () => {
  it("rounds each corner without overshooting short runs", () => {
    expect(
      routePath([
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 6 },
        { x: 40, y: 6 },
      ]),
    ).toBe("M 0 0 L 17 0 Q 20 0 20 3 L 20 3 Q 20 6 23 6 L 40 6");
  });
});

describe("workflowNodePositions", () => {
  it("lays out a workflow without saved positions automatically", () => {
    expect(workflowNodePositions(workflow())).toEqual(arrangeWorkflow(workflow()));
  });

  it("keeps saved positions and places a new stage beside one that routes to it", () => {
    const definition = workflow();
    const layout = {
      plan: { x: 0, y: 0 },
      build: { x: 400, y: 0 },
      review: { x: 700, y: 0 },
      end: { x: 1000, y: 0 },
    };
    const positions = workflowNodePositions({ ...definition, layout });
    expect(positions.build).toEqual(layout.build);
    // Nothing routes to the orphan. Its automatic spot overlaps Finish and then Review
    // (700 to 924 wide), so it ends up below Review, the taller of the two.
    expect(positions.orphan).toEqual({
      x: column(3),
      y: canvasNodeHeight(definition, "review") + CANVAS_ROW_GAP,
    });
    const added = workflowNodePositions({
      ...definition,
      layout,
      steps: {
        ...definition.steps,
        build: { type: "task", role: "builder", task: "Build", next: { built: "lint" } },
        lint: { type: "task", role: "builder", task: "Lint", next: { done: "review" } },
      },
    });
    // Right of build is taken by review, so lint goes below review.
    expect(added.lint).toEqual({
      x: 400 + CANVAS_COLUMN_WIDTH,
      y: canvasNodeHeight(definition, "review") + CANVAS_ROW_GAP,
    });
  });
});

describe("workflowNodePositions with a dragged layout", () => {
  it("moves a new stage clear of a node that sits less than a column to its right", () => {
    const definition = workflow();
    const layout = { plan: { x: -300, y: 0 }, build: { x: 0, y: 0 }, review: { x: 480, y: 0 } };
    const positions = workflowNodePositions({
      ...definition,
      layout,
      steps: {
        ...definition.steps,
        build: { type: "task", role: "builder", task: "Build", next: { built: "lint" } },
        lint: { type: "task", role: "builder", task: "Lint", next: { done: "review" } },
      },
    });
    // Right of build is (300, 0), which would cover review's left edge at 480.
    expect(positions.lint).toEqual({
      x: CANVAS_COLUMN_WIDTH,
      y: canvasNodeHeight(definition, "review") + CANVAS_ROW_GAP,
    });
  });
});

describe("withNodePositions", () => {
  it("saves whole-pixel positions for every step and ignores unknown ids", () => {
    const definition = withNodePositions(workflow(), {
      plan: { x: 10.4, y: -3.6 },
      end: { x: 900, y: 0 },
      gone: { x: 1, y: 1 },
    });
    expect(definition.layout).toEqual({ plan: { x: 10, y: -4 }, end: { x: 900, y: 0 } });
  });

  it("returns the same definition when nothing moved", () => {
    const definition = withNodePositions(workflow(), { plan: { x: 10, y: 0 } });
    expect(withNodePositions(definition, { plan: { x: 10.2, y: 0 } })).toBe(definition);
  });

  it("drops a removed stage's position and keeps the others", () => {
    const definition = withNodePositions(workflow(), {
      plan: { x: 0, y: 0 },
      orphan: { x: 1, y: 1 },
    });
    expect(removeStage(definition, "orphan").layout).toEqual({ plan: { x: 0, y: 0 } });
    // A stage added since the layout was saved has no position of its own.
    const unplaced = withNodePositions(workflow(), { plan: { x: 0, y: 0 } });
    expect(removeStage(unplaced, "orphan").layout).toEqual({ plan: { x: 0, y: 0 } });
  });
});

describe("route edits", () => {
  it("points an existing outcome at another step, but not at its own stage", () => {
    const connected = connectRoute(workflow(), "plan", "fail", "review");
    const plan = connected.steps.plan;
    expect(plan?.type === "task" && plan.next).toEqual({ ready: "build", fail: "review" });
    expect(connectRoute(workflow(), "plan", "fail", "plan").steps.plan).toEqual(
      workflow().steps.plan,
    );
    expect(connectRoute(workflow(), "plan", "missing", "review").steps.plan).toEqual(
      workflow().steps.plan,
    );
  });

  it("removes a route with its outcome and limit, keeping each stage's last outcome", () => {
    const review = removeRoute(workflow(), "review", "changes_requested").steps.review;
    expect(review?.type === "task" && review.next).toEqual({ approved: "end" });
    expect(review?.type === "task" && "limits" in review).toBe(false);
    expect(canRemoveRoute(workflow(), "build")).toBe(false);
    expect(removeRoute(workflow(), "build", "built").steps.build).toEqual(workflow().steps.build);
  });

  it("names the stages that still route to a stage", () => {
    expect(stagesRoutingTo(workflow(), "build")).toEqual(["plan", "review"]);
    expect(stagesRoutingTo(workflow(), "orphan")).toEqual([]);
  });
});
