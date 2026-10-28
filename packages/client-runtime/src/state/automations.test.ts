import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botAutomationsDeleteWarning,
  createAutomationRunIndex,
  groupAutomationsByBot,
  hasUnseenAutomationFailure,
  isAutomationFailureUnseen,
  isAutomationRunning,
  runningAutomationKeys,
} from "./automations.ts";
import { buildLogicalBots } from "./botRail.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const runId = RunId.make("run");

const task = (id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: ScheduledTaskId.make(id),
  title: id,
  prompt: "Do the thing",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("app"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
  ...overrides,
});

const shell = (
  id: string,
  input: {
    title: string;
    createdAt: string;
    projectId?: string;
    working?: boolean;
    requestedAt?: string;
  },
) => ({
  environmentId: local,
  id: ThreadId.make(id),
  projectId: ProjectId.make(input.projectId ?? "app"),
  title: input.title,
  createdAt: input.createdAt,
  hasActionableProposedPlan: false,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingSubagentRequest: null,
  interactionMode: "default" as const,
  latestRun:
    input.requestedAt === undefined
      ? null
      : {
          runId,
          status: input.working ? ("running" as const) : ("completed" as const),
          requestedAt: input.requestedAt,
          startedAt: input.requestedAt,
          completedAt: input.working ? null : input.requestedAt,
          assistantMessageId: null,
        },
  runtime: input.working
    ? {
        status: "running" as const,
        activeRunId: runId,
        providerInstanceId: "codex" as never,
        providerName: null,
        lastError: null,
        updatedAt: input.requestedAt ?? input.createdAt,
      }
    : null,
});

const avatar = {
  head: "round",
  eyes: "round",
  face: "visor",
  top: "ball",
  cheeks: false,
  smile: false,
} as const;
const bots = buildLogicalBots([
  {
    environmentId: local,
    bots: [
      { id: CAPTAIN_BOT_ID, name: "Captain", avatar, color: "blue", position: 0 },
      { id: "bot-social", name: "Social", avatar, color: "blue", position: 1 },
    ],
  },
  {
    environmentId: remote,
    bots: [{ id: "bot-social-2", name: "Social", avatar, color: "blue", position: 0 }],
  },
]);

describe("groupAutomationsByBot", () => {
  it("groups tasks under their project's bot across environments, in rail order", () => {
    const groups = groupAutomationsByBot({
      environments: [
        {
          environmentId: local,
          tasks: [
            task("Triage", { projectId: ProjectId.make("blog") }),
            task("Nightly build", { projectId: ProjectId.make("app") }),
          ],
        },
        {
          environmentId: remote,
          tasks: [task("Analytics", { projectId: ProjectId.make("site") })],
        },
      ],
      projects: [
        { environmentId: local, id: ProjectId.make("app") },
        { environmentId: local, id: ProjectId.make("blog"), botId: "bot-social" },
        { environmentId: remote, id: ProjectId.make("site"), botId: "bot-social-2" },
      ],
      bots,
    });
    expect(
      groups.map((group) => [group.bot?.name, group.entries.map((entry) => entry.key)]),
    ).toEqual([
      ["Captain", ["local:Nightly build"]],
      ["Social", ["remote:Analytics", "local:Triage"]],
    ]);
  });

  it("puts a task posting into a headquarters under that bot", () => {
    const groups = groupAutomationsByBot({
      environments: [
        {
          environmentId: local,
          tasks: [task("Standup", { threadId: botHeadquartersThreadId("bot-social") })],
        },
      ],
      projects: [{ environmentId: local, id: ProjectId.make("app") }],
      bots,
    });
    expect(groups.map((group) => group.bot?.name)).toEqual(["Social"]);
  });

  it("puts a task that runs as a bot under that bot, whatever its project", () => {
    const groups = groupAutomationsByBot({
      environments: [
        { environmentId: local, tasks: [task("Weekly post", { botId: "bot-social" })] },
      ],
      projects: [{ environmentId: local, id: ProjectId.make("app") }],
      bots,
    });
    expect(groups.map((group) => group.bot?.name)).toEqual(["Social"]);
  });

  it("keeps tasks visible when the rail knows no bots", () => {
    const groups = groupAutomationsByBot({
      environments: [{ environmentId: local, tasks: [task("Nightly")] }],
      projects: [],
      bots: [],
    });
    expect(groups.map((group) => [group.bot, group.entries.length])).toEqual([[null, 1]]);
  });
});

describe("createAutomationRunIndex", () => {
  it("finds an unbound task's runs by project and title since it was created, newest first", () => {
    const runs = createAutomationRunIndex([
      shell("old", { title: "Nightly", createdAt: "2026-09-30T00:00:00.000Z" }),
      shell("first", { title: "Nightly", createdAt: "2026-10-01T01:00:00.000Z" }),
      shell("second", { title: "Nightly", createdAt: "2026-10-02T01:00:00.000Z" }),
      shell("other", {
        title: "Nightly",
        createdAt: "2026-10-02T01:00:00.000Z",
        projectId: "blog",
      }),
      shell("renamed", { title: "Something else", createdAt: "2026-10-02T01:00:00.000Z" }),
    ]);
    expect(runs(local, task("Nightly")).map((thread) => thread.id)).toEqual(["second", "first"]);
    expect(runs(remote, task("Nightly"))).toEqual([]);
  });

  it("finds a bound task's thread whatever its title", () => {
    const runs = createAutomationRunIndex([
      shell("bound", { title: "My chat", createdAt: "2026-09-01T00:00:00.000Z" }),
    ]);
    expect(
      runs(local, task("Nightly", { threadId: ThreadId.make("bound") })).map((thread) => thread.id),
    ).toEqual(["bound"]);
  });
});

describe("bot automations", () => {
  it("finds a bot task's runs in the bot's headquarters", () => {
    const headquarters = botHeadquartersThreadId("bot-social");
    const runs = createAutomationRunIndex([
      shell(headquarters, { title: "Social", createdAt: "2026-09-01T00:00:00.000Z" }),
      shell("same-title", { title: "Weekly post", createdAt: "2026-10-02T00:00:00.000Z" }),
    ]);
    expect(
      runs(local, task("Weekly post", { botId: "bot-social" })).map((thread) => thread.id),
    ).toEqual([headquarters]);
  });

  it("warns that deleting a bot deletes its automations, naming the count", () => {
    const tasks = [
      task("a", { botId: "bot-social" }),
      task("b", { botId: "bot-social" }),
      task("c", { botId: "bot-finance" }),
      task("d"),
    ];
    expect(botAutomationsDeleteWarning(tasks, "bot-social")).toBe(
      "Its 2 automations will be deleted too.",
    );
    expect(botAutomationsDeleteWarning(tasks, "bot-finance")).toBe(
      "Its 1 automation will be deleted too.",
    );
    expect(botAutomationsDeleteWarning(tasks, "bot-quiet")).toBeNull();
  });
});

describe("isAutomationRunning", () => {
  const lastRunAt = "2026-10-02T01:00:00.000Z";

  it("is running while the server dispatches it", () => {
    expect(isAutomationRunning(task("Nightly", { lastRunStatus: "running" }), [])).toBe(true);
  });

  it("is running while the thread its last run went to works on it", () => {
    const fired = task("Nightly", { lastRunStatus: "succeeded", lastRunAt });
    const working = shell("run", {
      title: "Nightly",
      createdAt: lastRunAt,
      working: true,
      requestedAt: lastRunAt,
    });
    expect(isAutomationRunning(fired, [working])).toBe(true);
    const finished = shell("run", {
      title: "Nightly",
      createdAt: lastRunAt,
      requestedAt: lastRunAt,
    });
    expect(isAutomationRunning(fired, [finished])).toBe(false);
  });

  it("ignores a bound thread working on a run from before the task fired", () => {
    const fired = task("Nightly", { lastRunStatus: "succeeded", lastRunAt });
    const earlier = shell("bound", {
      title: "Chat",
      createdAt: "2026-09-01T00:00:00.000Z",
      working: true,
      requestedAt: "2026-10-02T00:59:00.000Z",
    });
    expect(isAutomationRunning(fired, [earlier])).toBe(false);
  });

  it("collects running keys across environments", () => {
    expect(
      runningAutomationKeys(
        [
          {
            environmentId: local,
            tasks: [task("Nightly", { lastRunStatus: "running" }), task("Idle")],
          },
        ],
        [],
      ),
    ).toEqual(new Set(["local:Nightly"]));
  });
});

describe("unseen automation failures", () => {
  const failedAt = "2026-10-02T01:00:00.000Z";
  const failed = task("Nightly", { lastRunStatus: "failed", lastRunAt: failedAt });

  it("reads a failure as unseen until that run is seen, and again when a newer run fails", () => {
    expect(isAutomationFailureUnseen(failed, undefined)).toBe(true);
    expect(isAutomationFailureUnseen(failed, failedAt)).toBe(false);
    expect(isAutomationFailureUnseen(failed, "2026-10-01T01:00:00.000Z")).toBe(true);
    expect(isAutomationFailureUnseen({ ...failed, lastRunStatus: "succeeded" }, undefined)).toBe(
      false,
    );
  });

  it("checks every environment's tasks", () => {
    const environments = [
      { environmentId: local, tasks: [task("Fine")] },
      { environmentId: remote, tasks: [failed] },
    ];
    expect(hasUnseenAutomationFailure(environments, {})).toBe(true);
    expect(hasUnseenAutomationFailure(environments, { "remote:Nightly": failedAt })).toBe(false);
  });
});
