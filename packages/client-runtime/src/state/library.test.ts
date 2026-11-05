import {
  EnvironmentId,
  FEATURE_MANAGER_ROLE_ID,
  PROJECT_MANAGER_ROLE_ID,
  ProviderInstanceId,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { libraryRoleEntries, roleAvailabilityNote, workflowRoles } from "./library.ts";

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
  revision: 1,
  ...overrides,
});

const delivery: WorkflowConfig = {
  id: "workflow:feature-delivery",
  name: "Feature delivery",
  instructions: "Plan, build, QA.",
  leadRoleId: FEATURE_MANAGER_ROLE_ID,
  crewRoleIds: ["role:builder"],
  revision: 1,
};

describe("roleAvailabilityNote", () => {
  it("says when a role is off or no workflow leads or uses it", () => {
    expect(roleAvailabilityNote(role("role:builder"), [delivery])).toBeNull();
    expect(roleAvailabilityNote(role(FEATURE_MANAGER_ROLE_ID), [delivery])).toBeNull();
    expect(roleAvailabilityNote(role("role:builder", { enabled: false }), [delivery])).toBe("Off");
    expect(roleAvailabilityNote(role("role:helper"), [delivery])).toBe("Not in a workflow");
    expect(roleAvailabilityNote(role(PROJECT_MANAGER_ROLE_ID), [delivery])).toBeNull();
  });
});

describe("workflowRoles", () => {
  it("leaves the Project manager out of a workflow's lead and crew choices", () => {
    const roles = [
      role(FEATURE_MANAGER_ROLE_ID),
      role(PROJECT_MANAGER_ROLE_ID),
      role("role:builder"),
    ];
    expect(workflowRoles(roles).map((each) => each.id)).toEqual([
      FEATURE_MANAGER_ROLE_ID,
      "role:builder",
    ]);
  });
});

describe("libraryRoleEntries", () => {
  it("sorts roles by name and keeps an id per environment apart", () => {
    const entries = libraryRoleEntries([
      { environmentId: local, roles: [role("role:reviewer"), role("role:builder")], workflows: [] },
      { environmentId: remote, roles: [role("role:builder")], workflows: [] },
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      "local:role:builder",
      "remote:role:builder",
      "local:role:reviewer",
    ]);
  });
});
