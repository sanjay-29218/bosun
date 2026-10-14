import { PROJECT_MANAGER_ROLE_ID, WorkflowDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { nextWorkflowStep, validateWorkflowDefinition } from "./WorkflowGraph.ts";

const definition: WorkflowDefinition = {
  schemaVersion: 2,
  id: "delivery",
  name: "Delivery",
  revision: 1,
  start: "build",
  roles: {
    manager: { roleId: PROJECT_MANAGER_ROLE_ID, roleRevision: 1, supervisor: null },
    builder: {
      roleId: "template-builder",
      roleRevision: 1,
      supervisor: "manager",
    },
    reviewer: {
      roleId: "template-reviewer",
      roleRevision: 1,
      supervisor: "manager",
    },
  },
  steps: {
    build: { type: "task", role: "builder", task: "Build", next: { built: "review" } },
    review: {
      type: "task",
      role: "reviewer",
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
        roles: {
          ...definition.roles,
          builder: { ...definition.roles.builder!, supervisor: "missing" },
        },
      }),
    ).toThrow(/Unknown supervisor/);
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        roles: {
          ...definition.roles,
          manager: { ...definition.roles.manager!, supervisor: "builder" },
        },
      }),
    ).toThrow(/Supervisor cycle/);
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        steps: {
          ...definition.steps,
          build: { type: "task", role: "builder", task: "Build", next: { built: "missing" } },
        },
      }),
    ).toThrow(/Invalid outcome route/);
    expect(() =>
      validateWorkflowDefinition({
        ...definition,
        steps: {
          ...definition.steps,
          build: { type: "task", role: "builder", task: "Build", next: { built: "build" } },
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
            role: "builder",
            task: "Build",
            next: { built: "review", stuck: "dead" },
          },
          dead: { type: "task", role: "builder", task: "Stuck", next: { again: "dead" } },
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

  it("rejects unsupported step kinds at the contract boundary", () => {
    const decode = Schema.decodeUnknownSync(WorkflowDefinition);
    expect(() => decode(definition)).not.toThrow();
    expect(() =>
      decode({ ...definition, steps: { build: { type: "script" }, end: { type: "end" } } }),
    ).toThrow();
  });
});
