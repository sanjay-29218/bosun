import {
  EnvironmentId,
  PROJECT_MANAGER_ROLE_ID,
  ProviderInstanceId,
  type RoleConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  libraryEntries,
  orderWorkflowStages,
  roleAvailabilityNote,
  workflowStagePath,
} from "./library.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const role = (id: string, overrides: Partial<RoleConfig> = {}): RoleConfig => ({
  id,
  name: id.replace("role:", ""),
  instructions: "Do the work",
  allowedTools: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "approval-required",
  enabled: true,
  autoCreateForFeature: true,
  revision: 1,
  ...overrides,
});

const workflow = (overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition => ({
  schemaVersion: 2,
  id: "feature-delivery",
  name: "Feature delivery",
  revision: 1,
  start: "plan",
  roles: {},
  steps: {
    review: { type: "task", role: "reviewer", task: "Review", next: { approved: "end" } },
    qa: { type: "task", role: "tester", task: "Test", next: { passed: "review" } },
    build: { type: "task", role: "builder", task: "Build", next: { built: "qa" } },
    plan: { type: "task", role: "planner", task: "Plan", next: { ready: "build" }, gate: true },
    orphan: { type: "task", role: "builder", task: "Unused", next: { done: "end" } },
    end: { type: "end" },
  },
  defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
  ...overrides,
});

describe("orderWorkflowStages", () => {
  it("follows routes from the start, with unreachable stages last", () => {
    expect(orderWorkflowStages(workflow())).toEqual(["plan", "build", "qa", "review", "orphan"]);
  });
});

describe("workflowStagePath", () => {
  it("names the stages in the order a feature meets them", () => {
    expect(workflowStagePath(workflow())).toBe("Plan → Build → QA → Review → Orphan");
  });

  it("is empty for a workflow without stages", () => {
    expect(workflowStagePath(workflow({ start: "end", steps: { end: { type: "end" } } }))).toBe("");
  });
});

describe("roleAvailabilityNote", () => {
  it("says when a role is off or kept out of workflow stages", () => {
    expect(roleAvailabilityNote(role("role:builder"))).toBeNull();
    expect(roleAvailabilityNote(role("role:builder", { enabled: false }))).toBe("Off");
    expect(roleAvailabilityNote(role("role:helper", { autoCreateForFeature: false }))).toBe(
      "Not available to workflow stages",
    );
  });

  it("leaves the project manager alone, since it joins as the project's manager", () => {
    expect(
      roleAvailabilityNote(role(PROJECT_MANAGER_ROLE_ID, { autoCreateForFeature: false })),
    ).toBeNull();
  });
});

describe("libraryEntries", () => {
  it("sorts each list by name and keeps an id per environment apart", () => {
    const entries = libraryEntries([
      {
        environmentId: local,
        workflows: [workflow(), workflow({ id: "bugfix", name: "bugfix" })],
        roles: [role("role:reviewer"), role("role:builder")],
      },
      { environmentId: remote, workflows: [workflow()], roles: [] },
    ]);
    expect(entries.workflows.map((entry) => entry.key)).toEqual([
      "local:bugfix",
      "local:feature-delivery",
      "remote:feature-delivery",
    ]);
    expect(entries.workflows[1]?.stagePath).toBe("Plan → Build → QA → Review → Orphan");
    expect(entries.roles.map((entry) => entry.key)).toEqual([
      "local:role:builder",
      "local:role:reviewer",
    ]);
  });
});
