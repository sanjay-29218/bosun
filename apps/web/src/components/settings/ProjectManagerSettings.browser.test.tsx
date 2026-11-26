import {
  CrewOperationError,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  type ProjectManagerSettings,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";
import { RegistryContext } from "@effect/atom-react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { ProjectManagerSection } from "./ProjectManagerSettings";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project:web");
const settings = (fields: Partial<ProjectManagerSettings> = {}): ProjectManagerSettings => ({
  projectId,
  enabled: true,
  instructions: "Manage the web app.",
  customized: false,
  revision: 1,
  threadId: null,
  icon: null,
  ...fields,
});

const state = vi.hoisted(() => ({
  update: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
  reset: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
  setIcon: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
  // The settings the server holds. Kept here, not as an extra export of the mocked module:
  // Vitest's browser mocker drops exports the real module doesn't have.
  held: null as Atom.Writable<AsyncResult.AsyncResult<ProjectManagerSettings, never>> | null,
}));

vi.mock(import("../../state/roles"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const held = Atom.make<AsyncResult.AsyncResult<ProjectManagerSettings, never>>(
    AsyncResult.initial(),
  ).pipe(Atom.keepAlive);
  state.held = held;
  // A refresh reads the server again, which is what `held` says now.
  const query = Atom.make((get) => get(held));
  return {
    ...actual,
    rolesEnvironment: {
      ...actual.rolesEnvironment,
      projectManager: (() => query) as never,
      updateProjectManager: {
        ...actual.rolesEnvironment.updateProjectManager,
        permissionAtom: () => allowed,
      },
      resetProjectManager: {
        ...actual.rolesEnvironment.resetProjectManager,
        permissionAtom: () => allowed,
      },
      setProjectManagerIcon: {
        ...actual.rolesEnvironment.setProjectManagerIcon,
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
      command === rolesEnvironment.updateProjectManager
        ? state.update
        : command === rolesEnvironment.resetProjectManager
          ? state.reset
          : command === rolesEnvironment.setProjectManagerIcon
            ? state.setIcon
            : actual.useAtomCommand(command)) as never,
  };
});
vi.mock(import("../../confirmDialog"), async (original) => ({
  ...(await original()),
  requestConfirmDialog: (async () => true) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIdentities: (() => []) as never,
  usePrimaryEnvironmentId: (() => null) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

// A test changes the server's settings as a save or reset would.
async function serverHolds(next: ProjectManagerSettings) {
  const held = state.held;
  if (!held) throw new Error("The state/roles mock hasn't loaded");
  await act(async () => appAtomRegistry.set(held, AsyncResult.success(next)));
}

const section = () => (
  <RegistryContext.Provider value={appAtomRegistry}>
    <ProjectManagerSection members={members} />
  </RegistryContext.Provider>
);

const members = [{ environmentId, id: projectId, title: "Web", environmentLabel: null }];

describe("ProjectManagerSection", () => {
  it("resets a customized manager to its defaults", async () => {
    await serverHolds(settings({ customized: true, instructions: "My own way.", revision: 4 }));
    state.reset = vi.fn(async () => {
      await serverHolds(settings({ revision: 5 }));
      return AsyncResult.success(settings({ revision: 5 }));
    });
    await using _screen = await render(section());
    await expect
      .element(page.getByText("Customized for this project.", { exact: false }))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Reset to defaults" }));

    expect(state.reset).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, expectedRevision: 4 },
    });
    await expect.element(page.getByText("Built-in instructions", { exact: false })).toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Instructions" }))
      .toHaveTextContent("Manage the web app.");
    await expect
      .element(page.getByRole("button", { name: "Reset to defaults" }))
      .not.toBeInTheDocument();
  });

  it("drops unsaved edits on reset, even when the server's settings come back unchanged", async () => {
    // Customized, yet saved with what the defaults hold, so a reset changes no saved field.
    await serverHolds(settings({ customized: true, revision: 4 }));
    state.reset = vi.fn(async () => {
      await serverHolds(settings({ customized: true, revision: 5 }));
      return AsyncResult.success(settings({ customized: true, revision: 5 }));
    });
    await using _screen = await render(section());
    const instructions = page.getByRole("textbox", { name: "Instructions" });
    await userEvent.fill(instructions, "Not saved.");

    await userEvent.click(page.getByRole("button", { name: "Reset to defaults" }));

    expect(state.reset).toHaveBeenCalledOnce();
    await expect.element(instructions).toHaveTextContent("Manage the web app.");
    await expect.element(page.getByText("Unsaved changes")).not.toBeInTheDocument();
  });

  it("saves a new look on its own, keeping what's being typed for the next save", async () => {
    await serverHolds(settings());
    const chosen = { avatar: expect.any(Object), color: "teal" };
    state.setIcon = vi.fn(async (...args: ReadonlyArray<unknown>) => {
      const { icon } = (args[0] as { input: Pick<ProjectManagerSettings, "icon"> }).input;
      await serverHolds(settings({ icon, revision: 2 }));
      return AsyncResult.success(settings({ icon, revision: 2 }));
    });
    state.update = vi.fn(async () => AsyncResult.success(settings({ revision: 3 })));
    await using _screen = await render(section());
    const instructions = page.getByRole("textbox", { name: "Instructions" });
    await userEvent.fill(instructions, "Half typed.");

    await userEvent.click(page.getByRole("button", { name: "Change" }));
    await userEvent.click(page.getByRole("radio", { name: "Teal" }));
    await userEvent.click(page.getByRole("button", { name: "Save icon" }));

    expect(state.setIcon).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, icon: chosen },
    });
    await expect.element(page.getByRole("button", { name: "Use automatic" })).toBeVisible();
    await expect.element(instructions).toHaveTextContent("Half typed.");
    await userEvent.click(page.getByRole("button", { name: "Save" }));
    expect(state.update).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ instructions: "Half typed.", expectedRevision: 2 }),
    });
  });

  it("shows the newer settings when someone else saved first", async () => {
    await serverHolds(settings());
    // Another window saved revision 2 before this one.
    state.update = vi.fn(async () => {
      await serverHolds(settings({ instructions: "Their way.", customized: true, revision: 2 }));
      return AsyncResult.failure(
        Cause.fail(
          new CrewOperationError({
            reason: "The project manager changed; reload its settings and try again",
          }),
        ),
      );
    });
    await using _screen = await render(section());
    const instructions = page.getByRole("textbox", { name: "Instructions" });
    await userEvent.fill(instructions, "My way.");

    await userEvent.click(page.getByRole("button", { name: "Save" }));

    expect(state.update).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({ instructions: "My way.", expectedRevision: 1 }),
    });
    await expect.element(instructions).toHaveTextContent("Their way.");
    await expect
      .element(page.getByText("Customized for this project.", { exact: false }))
      .toBeVisible();
  });
});
