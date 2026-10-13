import { WorkflowDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { nextWorkflowStep, validateWorkflowDefinition } from "./WorkflowGraph.ts";

const definition: WorkflowDefinition = {
  schemaVersion: 1,
  id: "delivery",
  name: "Delivery",
  revision: 1,
  start: "build",
  bots: {
    manager: { template: { kind: "existing-project-bot", id: "bot-manager" }, supervisor: null },
    builder: {
      template: { kind: "template", id: "template-builder", revision: 1 },
      supervisor: "manager",
    },
    reviewer: {
      template: { kind: "template", id: "template-reviewer", revision: 1 },
      supervisor: "manager",
    },
  },
  steps: {
    build: { type: "task", bot: "builder", task: "Build", next: { built: "review" } },
    review: {
      type: "task",
      bot: "reviewer",
      task: "Review",
      next: { approved: "end", changes_requested: "build" },
    },
    end: { type: "end" },
  },
  defaults: {
    questions: "supervisor",
    failure: "pause",
    maxAttemptsPerExecution: 3,
    maxStepExecutions: 30,
  },
};

describe("workflow graph", () => {
  it("routes by explicit outcomes, including rework", () => {
    expect(() => validateWorkflowDefinition(definition)).not.toThrow();
    expect(nextWorkflowStep(definition, "review", "changes_requested")).toBe("build");
    expect(nextWorkflowStep(definition, "review", "approved")).toBe("end");
    expect(() => nextWorkflowStep(definition, "review", "turn_ended")).toThrow(/no transition/);
  });

  it("rejects invalid references and unfinishable cycles", () => {
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        bots: {
          ...definition.bots,
          builder: { ...definition.bots.builder!, supervisor: "missing" },
        },
      }),
    ).toThrow(/Unknown supervisor/);
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        bots: {
          ...definition.bots,
          manager: { ...definition.bots.manager!, supervisor: "builder" },
        },
      }),
    ).toThrow(/Supervisor cycle/);
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        steps: {
          ...definition.steps,
          build: { type: "task", bot: "builder", task: "Build", next: { built: "missing" } },
        },
      }),
    ).toThrow(/Invalid outcome route/);
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        steps: {
          ...definition.steps,
          build: { type: "task", bot: "builder", task: "Build", next: { built: "build" } },
        },
      }),
    ).toThrow(/reachable/);
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        steps: {
          ...definition.steps,
          build: {
            type: "task",
            bot: "builder",
            task: "Build",
            next: { built: "review", stuck: "dead" },
          },
          dead: { type: "task", bot: "builder", task: "Stuck", next: { again: "dead" } },
        },
      }),
    ).toThrow(/path to the end/);
  });

  it("checks declared outputs, received outputs and scope", () => {
    const withOutputs = (build: object, review: object = {}): WorkflowDefinition => ({
      ...definition,
      steps: {
        ...definition.steps,
        build: { ...definition.steps.build!, ...build } as WorkflowDefinition["steps"][string],
        review: { ...definition.steps.review!, ...review } as WorkflowDefinition["steps"][string],
      },
    });
    expect(() =>
      validateWorkflowDefinition(
        withOutputs(
          { outputs: ["docs/build-notes.md"], scope: "apps/web" },
          { receives: { files: ["docs/build-notes.md"], diffs: ["build"] } },
        ),
      ),
    ).not.toThrow();
    for (const path of ["/etc/passwd", "../plan.md", "a//b.md", "./plan.md", "a\\b.md", " x.md"]) {
      expect(() => validateWorkflowDefinition(withOutputs({ outputs: [path] }))).toThrow(
        /Invalid outputs/,
      );
    }
    expect(() =>
      validateWorkflowDefinition(withOutputs({ outputs: ["plan.md", "plan.md"] })),
    ).toThrow(/Invalid outputs/);
    expect(() =>
      validateWorkflowDefinition(withOutputs({}, { receives: { files: ["plan.md"], diffs: [] } })),
    ).toThrow(/no step produces/);
    expect(() =>
      validateWorkflowDefinition(withOutputs({}, { receives: { files: [], diffs: ["end"] } })),
    ).toThrow(/no step produces/);
  });

  it("accepts canvas positions only for steps that exist", () => {
    const layout = { build: { x: 0, y: 0 }, review: { x: 280, y: -40 }, end: { x: 560, y: 0 } };
    expect(() => validateWorkflowDefinition({ ...definition, layout })).not.toThrow();
    expect(() =>
      validateWorkflowDefinition({ ...definition, layout: { ...layout, gone: { x: 0, y: 0 } } }),
    ).toThrow(/Invalid layout/);
    expect(() =>
      validateWorkflowDefinition({ ...definition, layout: { build: { x: Number.NaN, y: 0 } } }),
    ).toThrow(/Invalid layout/);
  });

  it("rejects unsupported step kinds at the contract boundary", () => {
    const decode = Schema.decodeUnknownSync(WorkflowDefinition);
    expect(() => decode(definition)).not.toThrow();
    expect(() =>
      decode({ ...definition, steps: { build: { type: "script" }, end: { type: "end" } } }),
    ).toThrow();
  });
});
