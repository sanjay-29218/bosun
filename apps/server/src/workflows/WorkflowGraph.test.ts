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
  });

  it("rejects unsupported step kinds at the contract boundary", () => {
    const decode = Schema.decodeUnknownSync(WorkflowDefinition);
    expect(() => decode(definition)).not.toThrow();
    expect(() =>
      decode({ ...definition, steps: { build: { type: "script" }, end: { type: "end" } } }),
    ).toThrow();
  });
});
