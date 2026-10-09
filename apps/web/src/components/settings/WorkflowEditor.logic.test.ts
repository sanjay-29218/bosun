import {
  ProjectId,
  ProviderInstanceId,
  type BotTemplateConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canRemoveStage,
  describeStageInputs,
  ensureWorkflowRole,
  orderWorkflowStages,
  pruneUnusedRoles,
  refreshWorkflowRoles,
  removeStage,
  sameWorkflow,
  setRouteLimit,
  setStageOutcomes,
} from "./WorkflowEditor.logic";

const projectId = ProjectId.make("project-1");

function template(role: string, overrides: Partial<BotTemplateConfig> = {}): BotTemplateConfig {
  return {
    id: `template:${role}:${projectId}`,
    projectId,
    name: role.charAt(0).toUpperCase() + role.slice(1),
    instructions: "Do the work",
    allowedTools: [],
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "approval-required",
    enabled: true,
    autoCreateForFeature: true,
    revision: 1,
    ...overrides,
  };
}

function workflow(): WorkflowDefinition {
  const role = (name: string) => ({
    template: { kind: "template" as const, id: `template:${name}:${projectId}`, revision: 1 },
    supervisor: "manager",
  });
  return {
    schemaVersion: 1,
    id: "feature-delivery",
    name: "Feature delivery",
    revision: 3,
    start: "plan",
    bots: {
      manager: {
        template: { kind: "existing-project-bot", id: `bot-manager:${projectId}` },
        supervisor: null,
      },
      planner: role("planner"),
      builder: role("builder"),
      reviewer: role("reviewer"),
    },
    steps: {
      review: {
        type: "task",
        bot: "reviewer",
        task: "Review",
        next: { approved: "end", changes_requested: "build" },
        limits: { changes_requested: 3 },
        receives: { files: ["plan.md"], diffs: ["build"] },
      },
      build: { type: "task", bot: "builder", task: "Build", next: { built: "review" } },
      plan: {
        type: "task",
        bot: "planner",
        task: "Plan",
        next: { ready: "build" },
        gate: true,
        outputs: ["plan.md"],
      },
      orphan: { type: "task", bot: "builder", task: "Unused", next: { done: "end" } },
      end: { type: "end" },
    },
    defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
  };
}

describe("orderWorkflowStages", () => {
  it("follows routes from the start, with unreachable stages last", () => {
    expect(orderWorkflowStages(workflow())).toEqual(["plan", "build", "review", "orphan"]);
  });
});

describe("describeStageInputs", () => {
  it("names picked files and diffs, and every earlier output by default", () => {
    const definition = workflow();
    expect(describeStageInputs(definition, "review")).toBe(
      "Gets plan.md, the Build changes and your notes",
    );
    expect(describeStageInputs(definition, "build")).toBe(
      "Gets every earlier output and your notes",
    );
  });
});

describe("refreshWorkflowRoles", () => {
  it("moves edited roles to their current revision and flags turned-off roles", () => {
    const result = refreshWorkflowRoles(workflow(), [
      template("planner", { revision: 4 }),
      template("builder", { enabled: false }),
      template("reviewer"),
    ]);
    expect(result.issues).toEqual([
      { botId: "planner", name: "Planner", reason: "changed" },
      { botId: "builder", name: "Builder", reason: "unavailable" },
    ]);
    const planner = result.definition.bots.planner!.template;
    expect(planner.kind === "template" && planner.revision).toBe(4);
  });

  it("returns the same definition when every role is current", () => {
    const definition = workflow();
    const result = refreshWorkflowRoles(definition, [
      template("planner"),
      template("builder"),
      template("reviewer"),
    ]);
    expect(result.definition).toBe(definition);
    expect(result.issues).toEqual([]);
  });
});

describe("stage edits", () => {
  it("keeps a stage while anything starts at or routes to it", () => {
    const definition = workflow();
    expect(canRemoveStage(definition, "plan")).toBe(false);
    expect(canRemoveStage(definition, "build")).toBe(false);
    expect(canRemoveStage(definition, "orphan")).toBe(true);
  });

  it("drops a removed stage's outputs from later stages' picks", () => {
    const definition = removeStage(setStageOutcomes(workflow(), "plan", ["ready"]), "plan");
    const review = definition.steps.review;
    expect(review?.type === "task" && review.receives).toEqual({ files: [], diffs: ["build"] });
  });

  it("keeps routes and limits for kept outcomes and routes new ones to the end", () => {
    const definition = setStageOutcomes(workflow(), "review", ["changes_requested", "blocked"]);
    const review = definition.steps.review;
    expect(review?.type === "task" && review.next).toEqual({
      changes_requested: "build",
      blocked: "end",
    });
    expect(review?.type === "task" && review.limits).toEqual({ changes_requested: 3 });
    const unlimited = setRouteLimit(definition, "review", "changes_requested", null).steps.review;
    expect(unlimited?.type === "task" && "limits" in unlimited).toBe(false);
  });

  it("adds a role under the Manager and prunes roles no stage uses", () => {
    const { definition, botId } = ensureWorkflowRole(workflow(), template("designer"));
    expect(botId).toBe("designer");
    expect(definition.bots.designer?.supervisor).toBe("manager");
    // The Manager stays: other roles answer to it.
    expect(Object.keys(pruneUnusedRoles(definition).bots)).toEqual([
      "manager",
      "planner",
      "builder",
      "reviewer",
    ]);
  });
});

describe("sameWorkflow", () => {
  it("ignores key order", () => {
    expect(sameWorkflow({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameWorkflow({ a: 1 }, { a: 1, b: undefined })).toBe(false);
  });
});
