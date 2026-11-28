import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  FEATURE_DELIVERY_WORKFLOW_ID,
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
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  fallbackModelSelection: null,
  enabled: true,
  revision: 1,
  importedFrom: null,
  importers: [],
};
const designer: RoleConfig = { ...reviewer, id: "role:designer", name: "Designer" };
const featureDelivery: WorkflowConfig = {
  id: FEATURE_DELIVERY_WORKFLOW_ID,
  name: "Feature delivery",
  instructions: "Plan, build and review",
  crewRoleIds: [reviewer.id],
  revision: 3,
  importedFrom: null,
  importers: [],
};
const studio = EnvironmentId.make("studio");
const fromStudio = {
  environmentId: studio,
  label: "Studio VPS",
  revision: 2,
  localRevision: 1,
  available: 3,
  skipped: null,
  problem: null,
};

// Stable arrays, like the query results the real hook returns.
const state = vi.hoisted(() => ({
  connected: true,
  roles: [] as RoleConfig[],
  workflows: [] as WorkflowConfig[],
  canEditRoles: true,
  updateRole: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
  updateWorkflow: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
  importItems: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
}));

function setup(roles: RoleConfig[], workflows: WorkflowConfig[] = []) {
  state.connected = true;
  state.roles = roles;
  state.workflows = workflows;
  state.canEditRoles = true;
  state.updateRole = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.updateWorkflow = vi.fn(async () => ({ _tag: "Success", value: undefined }));
  state.importItems = vi.fn(async () => ({
    _tag: "Success",
    value: { imported: [], skipped: [] },
  }));
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
  const denied = Atom.make(false);
  return {
    ...actual,
    rolesEnvironment: {
      ...actual.rolesEnvironment,
      update: {
        ...actual.rolesEnvironment.update,
        permissionAtom: () => (state.canEditRoles ? allowed : denied),
      },
      updateWorkflow: {
        ...actual.rolesEnvironment.updateWorkflow,
        permissionAtom: () => allowed,
      },
      deleteWorkflow: {
        ...actual.rolesEnvironment.deleteWorkflow,
        permissionAtom: () => allowed,
      },
      importItems: {
        ...actual.rolesEnvironment.importItems,
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
        : command === rolesEnvironment.update
          ? state.updateRole
          : command === rolesEnvironment.importItems
            ? state.importItems
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
    await using screen = await render(<LibraryPage kind="role" search={selection} />);
    const instructions = page.getByRole("textbox", { name: "Instructions" });
    await expect.element(instructions).toHaveTextContent("Review the change");
    await userEvent.fill(instructions, "Review the change for security");

    state.connected = false;
    await screen.rerender(<LibraryPage kind="role" search={selection} />);
    await expect.element(instructions).toHaveTextContent("Review the change for security");

    state.connected = true;
    await screen.rerender(<LibraryPage kind="role" search={selection} />);
    await expect.element(instructions).toHaveTextContent("Review the change for security");
  });

  it("saves a workflow's crew, and keeps Feature delivery from being deleted", async () => {
    setup([reviewer, designer], [featureDelivery]);
    await using _screen = await render(
      <LibraryPage
        kind="workflow"
        search={{ environmentId, workflowId: FEATURE_DELIVERY_WORKFLOW_ID }}
      />,
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
        crewRoleIds: [reviewer.id, designer.id],
        expectedRevision: 3,
      },
    });
  });

  it("turns a role off from the list, only with edit permission", async () => {
    setup([reviewer]);
    const toggle = page.getByRole("switch", { name: "New features use Reviewer" });
    state.canEditRoles = false;
    {
      await using _screen = await render(<LibraryPage kind="role" search={{}} />);
      await expect.element(toggle).toHaveAttribute("data-disabled");
    }

    state.canEditRoles = true;
    await using _screen = await render(<LibraryPage kind="role" search={{}} />);
    await userEvent.click(toggle);
    expect(state.updateRole).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ id: reviewer.id, enabled: false, expectedRevision: 1 }),
    });
  });

  it("says when the selected role no longer exists", async () => {
    setup([reviewer]);
    await using _screen = await render(
      <LibraryPage kind="role" search={{ environmentId, roleId: "role:designer" }} />,
    );
    await expect.element(page.getByText("Role unavailable")).toBeInTheDocument();
  });

  it("shows where an imported role came from, and that its source has a newer one", async () => {
    setup([{ ...reviewer, importedFrom: fromStudio }]);
    await using _screen = await render(<LibraryPage kind="role" search={{}} />);
    await expect.element(page.getByText(/From Studio VPS/)).toBeInTheDocument();
    await expect.element(page.getByText("Update available")).toBeInTheDocument();
    // An import is editable, so its switch works.
    await expect
      .element(page.getByRole("switch", { name: "New features use Reviewer" }))
      .not.toHaveAttribute("data-disabled");
  });

  it("takes an imported role's update from its source", async () => {
    setup([{ ...reviewer, importedFrom: fromStudio }]);
    await using _screen = await render(
      <LibraryPage kind="role" search={{ environmentId, roleId: reviewer.id }} />,
    );
    await expect.element(page.getByText("Update available from Studio VPS")).toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Take update" }));
    expect(state.importItems).toHaveBeenCalledWith({
      environmentId,
      input: {
        sourceEnvironmentId: studio,
        roleIds: [reviewer.id],
        workflowIds: [],
        replace: false,
      },
    });
  });

  it("shows what was taken once an update lands", async () => {
    setup([{ ...reviewer, importedFrom: fromStudio }]);
    const selection = { environmentId, roleId: reviewer.id };
    await using screen = await render(<LibraryPage kind="role" search={selection} />);
    const instructions = page.getByRole("textbox", { name: "Instructions" });
    await expect.element(instructions).toHaveTextContent("Review the change");

    state.roles = [
      {
        ...reviewer,
        instructions: "Review the change and its tests",
        revision: 2,
        importedFrom: { ...fromStudio, revision: 3, localRevision: 2, available: null },
      },
    ];
    await screen.rerender(<LibraryPage kind="role" search={selection} />);
    await expect.element(instructions).toHaveTextContent("Review the change and its tests");
  });

  it("asks which importers take a save, with edited ones left unticked", async () => {
    const mini = EnvironmentId.make("mini");
    setup([
      {
        ...reviewer,
        importers: [
          {
            environmentId: studio,
            label: "Studio VPS",
            revision: 1,
            edited: false,
            seenAt: "2026-11-27T00:00:00.000Z",
            pending: false,
          },
          {
            environmentId: mini,
            label: "Mac mini",
            revision: 1,
            edited: true,
            seenAt: "2026-11-27T00:00:00.000Z",
            pending: false,
          },
        ],
      },
    ]);
    await using _screen = await render(
      <LibraryPage kind="role" search={{ environmentId, roleId: reviewer.id }} />,
    );
    await expect.element(page.getByText("Imported on")).toBeInTheDocument();
    await userEvent.fill(page.getByRole("textbox", { name: "Instructions" }), "Review it all");
    await userEvent.click(page.getByRole("button", { name: "Save role" }));
    await expect.element(page.getByText("Has local edits. Updating replaces them.")).toBeVisible();
    expect(state.updateRole).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Save and update 1" }));
    expect(state.updateRole).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        id: reviewer.id,
        instructions: "Review it all",
        alsoUpdateOn: [{ environmentId: studio, replacesEdits: false }],
      }),
    });
  });
});
