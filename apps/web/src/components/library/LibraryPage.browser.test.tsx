import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  type RoleConfig,
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
  autoCreateForFeature: true,
  revision: 1,
};

// Stable arrays, like the query results the real hook returns.
const state = vi.hoisted(() => ({
  connected: true,
  workflows: [] as never[],
  roles: [] as RoleConfig[],
}));

function setup(roles: RoleConfig[]) {
  state.connected = true;
  state.roles = roles;
}

vi.mock(import("../../state/library"), async (original) => {
  const { EnvironmentId } = await import("@t3tools/contracts");
  const libraries = () =>
    state.connected
      ? [
          {
            environmentId: EnvironmentId.make("laptop"),
            workflows: state.workflows,
            roles: state.roles,
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
    },
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

  it("says when the selected workflow no longer exists", async () => {
    setup([reviewer]);
    await using _screen = await render(
      <LibraryPage environmentId={environmentId} workflowId="feature-delivery" />,
    );
    await expect.element(page.getByText("Workflow unavailable")).toBeInTheDocument();
  });
});
