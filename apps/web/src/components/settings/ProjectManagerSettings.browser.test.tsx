import {
  CrewOperationError,
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
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
  instructions: "Manage the web app.",
  allowedTools: [],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  longConversation: "compact",
  customized: false,
  revision: 1,
  threadId: null,
  ...fields,
});

const state = vi.hoisted(() => ({
  update: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
  reset: (() => {}) as (...args: ReadonlyArray<unknown>) => unknown,
}));

// The settings the server holds; a test changes them as a save or reset would.
vi.mock(import("../../state/roles"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const held = Atom.make(AsyncResult.initial<ProjectManagerSettings, never>()).pipe(Atom.keepAlive);
  // A refresh reads the server again, which is what `held` says now.
  const query = Atom.make((get) => get(held));
  return {
    ...actual,
    heldProjectManager: held,
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

async function serverHolds(next: ProjectManagerSettings) {
  const roles = (await import("../../state/roles")) as unknown as {
    readonly heldProjectManager: Atom.Writable<AsyncResult.AsyncResult<ProjectManagerSettings>>;
  };
  await act(async () => appAtomRegistry.set(roles.heldProjectManager, AsyncResult.success(next)));
}

const section = () => (
  <RegistryContext.Provider value={appAtomRegistry}>
    <ProjectManagerSection members={members} />
  </RegistryContext.Provider>
);

const members = [{ environmentId, id: projectId, title: "Web", environmentLabel: null }];

describe("ProjectManagerSection", () => {
  it("resets a customized manager to its role, and then follows the role", async () => {
    await serverHolds(settings({ customized: true, instructions: "My own way.", revision: 4 }));
    state.reset = vi.fn(async () => {
      await serverHolds(settings({ revision: 5 }));
      return AsyncResult.success(settings({ revision: 5 }));
    });
    await using _screen = await render(section());
    await expect
      .element(page.getByText("Customized for this project.", { exact: false }))
      .toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Reset to role defaults" }));

    expect(state.reset).toHaveBeenCalledWith({
      environmentId,
      input: { projectId, expectedRevision: 4 },
    });
    await expect
      .element(page.getByText("Follows the Project manager role", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("textbox", { name: "Instructions" }))
      .toHaveTextContent("Manage the web app.");
    await expect
      .element(page.getByRole("button", { name: "Reset to role defaults" }))
      .not.toBeInTheDocument();
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
