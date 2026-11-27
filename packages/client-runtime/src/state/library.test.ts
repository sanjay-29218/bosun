import {
  EnvironmentId,
  ProviderInstanceId,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  libraryImportBanner,
  libraryImportButtonLabel,
  libraryImportLine,
  libraryRoleEntries,
  roleAvailabilityNote,
} from "./library.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const role = (id: string, overrides: Partial<RoleConfig> = {}): RoleConfig => ({
  id,
  name: id.replace("role:", ""),
  instructions: "Do the work",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  fallbackModelSelection: null,
  enabled: true,
  revision: 1,
  importedFrom: null,
  importers: [],
  ...overrides,
});

const delivery: WorkflowConfig = {
  id: "workflow:feature-delivery",
  name: "Feature delivery",
  instructions: "Plan, build, QA.",
  crewRoleIds: ["role:builder"],
  revision: 1,
  importedFrom: null,
  importers: [],
};

describe("roleAvailabilityNote", () => {
  it("says when a role is off or no workflow uses it", () => {
    expect(roleAvailabilityNote(role("role:builder"), [delivery])).toBeNull();
    expect(roleAvailabilityNote(role("role:builder", { enabled: false }), [delivery])).toBe("Off");
    expect(roleAvailabilityNote(role("role:helper"), [delivery])).toBe("Not in a workflow");
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

describe("imports", () => {
  const from = {
    environmentId: remote,
    label: "Studio VPS",
    revision: 3,
    localRevision: 1,
    available: null,
    skipped: null,
    problem: null,
  };
  it("says where one came from and how it stands", () => {
    expect(libraryImportLine(role("role:a"))).toBeNull();
    expect(libraryImportLine(role("role:a", { importedFrom: from }))).toBe("From Studio VPS");
    expect(libraryImportLine(role("role:a", { importedFrom: from, revision: 2 }))).toBe(
      "From Studio VPS · Changed here",
    );
    expect(
      libraryImportLine(role("role:a", { importedFrom: { ...from, problem: "notLinked" } })),
    ).toBe("From Studio VPS · Link it to get updates");
  });
  it("offers the update until it is skipped, and hides it behind a problem", () => {
    const newer = { ...from, available: 4 };
    expect(libraryImportBanner("role", role("role:a", { importedFrom: newer }))).toMatchObject({
      variant: "info",
      title: "Update available from Studio VPS",
      actions: ["take", "skip"],
    });
    expect(
      libraryImportBanner("role", role("role:a", { importedFrom: { ...newer, skipped: 4 } })),
    ).toMatchObject({ title: "Imported from Studio VPS", actions: ["detach"] });
    expect(
      libraryImportBanner(
        "role",
        role("role:a", { importedFrom: { ...newer, problem: "expired" } }),
      ),
    ).toMatchObject({ variant: "warning", title: "Link to Studio VPS expired" });
  });
});

describe("libraryImportButtonLabel", () => {
  it("counts the workflows and roles an import brings", () => {
    const workflow = { kind: "workflow" as const };
    const role = { kind: "role" as const };
    expect(libraryImportButtonLabel([role])).toBe("Import 1 role");
    expect(libraryImportButtonLabel([workflow, workflow])).toBe("Import 2 workflows");
    expect(libraryImportButtonLabel([workflow, role, role, role])).toBe(
      "Import 1 workflow, 3 roles",
    );
  });
});
