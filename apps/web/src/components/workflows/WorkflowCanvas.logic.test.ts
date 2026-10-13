import type { WorkflowDefinition } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { removeStage } from "../settings/WorkflowEditor.logic";
import {
  CANVAS_COLUMN_WIDTH,
  CANVAS_ROW_HEIGHT,
  autoLayoutWorkflow,
  canRemoveRoute,
  connectRoute,
  removeRoute,
  stagesRoutingTo,
  withNodePositions,
  workflowNodePositions,
  workflowRoutes,
} from "./WorkflowCanvas.logic";

function workflow(): WorkflowDefinition {
  return {
    schemaVersion: 1,
    id: "feature-delivery",
    name: "Feature delivery",
    revision: 1,
    start: "plan",
    bots: {
      builder: { template: { kind: "template", id: "builder", revision: 1 }, supervisor: null },
    },
    steps: {
      plan: { type: "task", bot: "builder", task: "Plan", next: { ready: "build", fail: "end" } },
      build: { type: "task", bot: "builder", task: "Build", next: { built: "review" } },
      review: {
        type: "task",
        bot: "builder",
        task: "Review",
        next: { approved: "end", changes_requested: "build" },
        limits: { changes_requested: 3 },
      },
      orphan: { type: "task", bot: "builder", task: "Unused", next: { done: "end" } },
      end: { type: "end" },
    },
    defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
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

describe("autoLayoutWorkflow", () => {
  it("puts stages in columns by distance from the start, unreachable ones next, and Finish last", () => {
    const positions = autoLayoutWorkflow(workflow());
    expect(positions.plan).toEqual({ x: column(0), y: 0 });
    expect(positions.build).toEqual({ x: column(1), y: 0 });
    expect(positions.review).toEqual({ x: column(2), y: 0 });
    expect(positions.orphan).toEqual({ x: column(3), y: 0 });
    expect(positions.end).toEqual({ x: column(4), y: 0 });
  });

  it("centres stages that share a column", () => {
    const definition = workflow();
    const positions = autoLayoutWorkflow({
      ...definition,
      steps: {
        ...definition.steps,
        plan: { type: "task", bot: "builder", task: "Plan", next: { a: "build", b: "orphan" } },
      },
    });
    expect(positions.build).toEqual({ x: column(1), y: -CANVAS_ROW_HEIGHT / 2 });
    expect(positions.orphan).toEqual({ x: column(1), y: CANVAS_ROW_HEIGHT / 2 });
    expect(positions.end).toEqual({ x: column(3), y: 0 });
  });
});

describe("workflowNodePositions", () => {
  it("lays out a workflow without saved positions automatically", () => {
    expect(workflowNodePositions(workflow())).toEqual(autoLayoutWorkflow(workflow()));
  });

  it("keeps saved positions and places a new stage beside one that routes to it", () => {
    const layout = {
      plan: { x: 0, y: 0 },
      build: { x: 400, y: 0 },
      // Taken: the new spot right of build moves down a row.
      review: { x: 700, y: 0 },
      end: { x: 1000, y: 0 },
    };
    const positions = workflowNodePositions({ ...workflow(), layout });
    expect(positions.build).toEqual(layout.build);
    // Nothing routes to the orphan: its automatic spot overlaps Finish, so it moves down.
    expect(positions.orphan).toEqual({ x: column(3), y: CANVAS_ROW_HEIGHT });
    const definition = workflow();
    const added = workflowNodePositions({
      ...definition,
      layout,
      steps: {
        ...definition.steps,
        build: { type: "task", bot: "builder", task: "Build", next: { built: "lint" } },
        lint: { type: "task", bot: "builder", task: "Lint", next: { done: "review" } },
      },
    });
    expect(added.lint).toEqual({ x: 400 + CANVAS_COLUMN_WIDTH, y: CANVAS_ROW_HEIGHT });
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

  it("drops a removed stage's position", () => {
    const definition = withNodePositions(workflow(), {
      plan: { x: 0, y: 0 },
      orphan: { x: 1, y: 1 },
    });
    expect(removeStage(definition, "orphan").layout).toEqual({ plan: { x: 0, y: 0 } });
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
