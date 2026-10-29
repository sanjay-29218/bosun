import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { useUiStateStore } from "../../uiStateStore";
import { AutomationsPage } from "./AutomationsPage";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const baseTask: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

const state = vi.hoisted(() => ({
  connected: true,
  tasks: [] as ScheduledTask[],
}));

function setup(tasks: ScheduledTask[]) {
  state.connected = true;
  state.tasks = tasks;
  useUiStateStore.setState({ seenAutomationFailureAtByKey: {} });
}

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected ? { environment: { platform: "linux" } } : null,
  };
}

vi.mock(import("../../state/automations"), async (original) => ({
  ...(await original()),
  useScheduledTasksByEnvironment: (() =>
    state.connected ? [{ environmentId, tasks: state.tasks, error: null }] : []) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: () => allowed,
      },
    },
  };
});
// A server without bots: the editor's bots query is never made, so it only offers a new thread.
vi.mock(import("../../state/bots"), async (original) => {
  const actual = await original();
  return { ...actual, botsEnvironment: { ...actual.botsEnvironment, list: (() => null) as never } };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data: request === null ? null : { tasks: state.tasks },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => environment()) as never,
  useEnvironments: (() => ({ environments: [environment()] })) as never,
  useConnectedEnvironmentIds: (() => (state.connected ? [environmentId] : [])) as never,
  usePrimaryEnvironmentId: (() => environmentId) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("AutomationsPage", () => {
  it("keeps a selected task's unsaved edits across a disconnect and reconnect", async () => {
    setup([baseTask]);
    const selection = { environmentId, taskId: baseTask.id };
    await using screen = await render(<AutomationsPage {...selection} />);
    const name = page.getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<AutomationsPage {...selection} />);
    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<AutomationsPage {...selection} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("says when the selected task no longer exists", async () => {
    setup([]);
    await using _screen = await render(
      <AutomationsPage environmentId={environmentId} taskId={baseTask.id} />,
    );
    await expect.element(page.getByText("Task unavailable")).toBeInTheDocument();
  });

  it("marks a failed run seen once its task is open", async () => {
    const failedAt = "2026-09-18T00:00:00.000Z";
    setup([{ ...baseTask, lastRunStatus: "failed", lastRunAt: failedAt, lastRunError: "boom" }]);
    await using _screen = await render(
      <AutomationsPage environmentId={environmentId} taskId={baseTask.id} />,
    );
    await expect.element(page.getByText("boom")).toBeInTheDocument();
    expect(useUiStateStore.getState().seenAutomationFailureAtByKey).toEqual({
      "laptop:nightly": failedAt,
    });
  });
});
