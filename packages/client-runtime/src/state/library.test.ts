import {
  EnvironmentId,
  PROJECT_MANAGER_ROLE_ID,
  ProviderInstanceId,
  type RoleConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { libraryRoleEntries, roleAvailabilityNote } from "./library.ts";

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

describe("roleAvailabilityNote", () => {
  it("says when a role is off or kept off feature crews", () => {
    expect(roleAvailabilityNote(role("role:builder"))).toBeNull();
    expect(roleAvailabilityNote(role("role:builder", { enabled: false }))).toBe("Off");
    expect(roleAvailabilityNote(role("role:helper", { autoCreateForFeature: false }))).toBe(
      "Not on feature crews",
    );
  });

  it("leaves the project manager alone, since it leads every feature", () => {
    expect(
      roleAvailabilityNote(role(PROJECT_MANAGER_ROLE_ID, { autoCreateForFeature: false })),
    ).toBeNull();
  });
});

describe("libraryRoleEntries", () => {
  it("sorts roles by name and keeps an id per environment apart", () => {
    const entries = libraryRoleEntries([
      { environmentId: local, roles: [role("role:reviewer"), role("role:builder")] },
      { environmentId: remote, roles: [role("role:builder")] },
    ]);
    expect(entries.map((entry) => entry.key)).toEqual([
      "local:role:builder",
      "remote:role:builder",
      "local:role:reviewer",
    ]);
  });
});
