import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  FEATURE_DELIVERY_WORKFLOW_ID,
  FEATURE_MANAGER_ROLE_ID,
  ProviderInstanceId,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { LibraryPage } from "./LibraryPage";

const environmentId = EnvironmentId.make("laptop");
const reviewer: RoleConfig = {
  id: "role:reviewer",
  name: "Reviewer",
  instructions: "Review the change",
  allowedTools: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "approval-required",
  enabled: true,
  revision: 1,
};
const featureManager: RoleConfig = { ...reviewer, id: FEATURE_MANAGER_ROLE_ID, name: "Lead" };
const designer: RoleConfig = { ...reviewer, id: "role:designer", name: "Designer" };
const featureDelivery: WorkflowConfig = {
  id: FEATURE_DELIVERY_WORKFLOW_ID,
  name: "Feature delivery",
  instructions: "Plan, build and review",
  leadRoleId: FEATURE_MANAGER_ROLE_ID,
  crewRoleIds: [reviewer.id],
  revision: 3,
};

// Stable arrays, like the query results the real hook returns.
const state = vi.hoisted(() => ({
  connected: true,
  roles: [] as RoleConfig[],
  workflows: [] as WorkflowConfig[],
  updateWorkflow: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
}));

function setup(roles: RoleConfig[], workflows: WorkflowConfig[] = []) {
  state.connected = true;
  state.roles = roles;
  state.workflows = workflows;
  state.updateWorkflow = vi.fn(async () => ({ _tag: "Success", value: undefined }));
}

vi.mock(import("../../state/library"), async (original) => {
  const { EnvironmentId } = await import("@t3tools/contracts");
  const libraries = () =>
    state.connected
      ? [
          {
            environmentId: EnvironmentId.make("laptop"),
            roles: state.roles,
            workflows: state.workflows,
            error: null,
          },
        ]
      : [];
  return {
    ...(await original()),
    useLibraries: libraries as never,
    useLibraryByEnvironment: libraries as never,
  };
});
vi.mock(import("../../state/roles"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    rolesEnvironment: {
      ...actual.rolesEnvironment,
      update: { ...actual.rolesEnvironment.update, permissionAtom: () => allowed },
      updateWorkflow: {
        ...actual.rolesEnvironment.updateWorkflow,
        permissionAtom: () => allowed,
      },
      deleteWorkflow: {
        ...actual.rolesEnvironment.deleteWorkflow,
        permissionAtom: () => allowed,
      },
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const actual = await original();
  const { rolesEnvironment } = await import("../../state/roles");
  return {
    ...actual,
    useAtomCommand: ((command: Parameters<typeof actual.useAtomCommand>[0]) =>
      command === rolesEnvironment.updateWorkflow
        ? state.updateWorkflow
        : actual.useAtomCommand(command)) as never,
  };
});
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentities: (() => []) as never,
  usePrimaryEnvironmentId: (() => null) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("LibraryPage", () => {
  it("keeps a selected role's unsaved edits across a disconnect and reconnect", async () => {
    setup([reviewer]);
    const selection = { environmentId, roleId: reviewer.id };
    await using screen = await render(<LibraryPage {...selection} />);
    const instructions = page.getByRole("textbox", { name: "Instructions" });
    await expect.element(instructions).toHaveTextContent("Review the change");
    await userEvent.fill(instructions, "Review the change for security");

    state.connected = false;
    await screen.rerender(<LibraryPage {...selection} />);
    await expect.element(instructions).toHaveTextContent("Review the change for security");

    state.connected = true;
    await screen.rerender(<LibraryPage {...selection} />);
    await expect.element(instructions).toHaveTextContent("Review the change for security");
  });

  it("saves a workflow's crew, and keeps Feature delivery from being deleted", async () => {
    setup([featureManager, reviewer, designer], [featureDelivery]);
    await using _screen = await render(
      <LibraryPage environmentId={environmentId} workflowId={FEATURE_DELIVERY_WORKFLOW_ID} />,
    );
    await expect.element(page.getByRole("button", { name: "Save workflow" })).toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Delete workflow" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByText("Designer"));
    await userEvent.click(page.getByRole("button", { name: "Save workflow" }));
    expect(state.updateWorkflow).toHaveBeenCalledWith({
      environmentId,
      input: {
        id: FEATURE_DELIVERY_WORKFLOW_ID,
        name: "Feature delivery",
        instructions: "Plan, build and review",
        leadRoleId: FEATURE_MANAGER_ROLE_ID,
        crewRoleIds: [reviewer.id, designer.id],
        expectedRevision: 3,
      },
    });
  });

  it("says when the selected role no longer exists", async () => {
    setup([reviewer]);
    await using _screen = await render(
      <LibraryPage environmentId={environmentId} roleId="role:designer" />,
    );
    await expect.element(page.getByText("Role unavailable")).toBeInTheDocument();
  });
});
