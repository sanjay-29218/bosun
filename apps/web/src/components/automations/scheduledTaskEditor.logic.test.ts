import {
  ProjectId,
  DEFAULT_SERVER_SETTINGS,
  type ServerConfig,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  runTargetFromDraft,
  scheduledTaskDefaultModel,
  defaultScheduledTaskProjectId,
  scheduleFromDraft,
  taskToDraft,
} from "./scheduledTaskEditor.logic";

describe("new scheduled task project", () => {
  it("defaults to a pinned open project, then any open one, never an archived one", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const project = (id: string, pinnedAt: string | null, archivedAt: string | null) => ({
      id: ProjectId.make(id),
      pinnedAt,
      archivedAt,
    });
    expect(defaultScheduledTaskProjectId([project("a", null, null), project("b", at, null)])).toBe(
      "b",
    );
    expect(defaultScheduledTaskProjectId([project("x", null, at)])).toBe("");
  });
});

const legacyTask: ScheduledTask = {
  id: ScheduledTaskId.make("legacy-task"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "worktree", baseRef: "release" },
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

describe("editing scheduled task branch settings", () => {
  it("keeps an omitted origin flag on the local base branch", () => {
    const draft = taskToDraft(legacyTask);
    expect(draft.baseRef).toBe("release");
    expect(draft.startFromOrigin).toBe(false);
  });
});

describe("runs as", () => {
  const thread = {
    projectId: ProjectId.make("project"),
    threadId: null,
    workspaceStrategy: { type: "worktree", baseRef: "main" },
  } as const;

  it("reopens a bot task on its bot and a thread task on a new thread", () => {
    expect(taskToDraft({ ...legacyTask, botId: "bot-social" }).botId).toBe("bot-social");
    expect(taskToDraft(legacyTask).botId).toBe("");
  });

  it("sends a bot task to the bot without a project, and a thread task back to its project", () => {
    expect(runTargetFromDraft({ botId: "bot-social" }, thread)).toEqual({
      botId: "bot-social",
      threadId: null,
      workspaceStrategy: { type: "root" },
    });
    expect(runTargetFromDraft({ botId: "" }, thread)).toEqual({ ...thread, botId: null });
  });
});

describe("one-time scheduled tasks", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips the run time through the local date-time input", () => {
    const runAt = "2026-11-03T17:00:42.000Z";
    const draft = taskToDraft({ ...legacyTask, schedule: { type: "once", runAt } });
    expect(draft.scheduleMode).toBe("once");
    expect(scheduleFromDraft(draft)).toEqual({ type: "once", runAt });
    const moved = scheduleFromDraft({ ...draft, runAt: "2026-11-04T09:30" });
    expect(moved).toEqual({ type: "once", runAt: new Date("2026-11-04T09:30").toISOString() });
    expect(scheduleFromDraft({ ...draft, runAt: "" })).toBeNull();
  });

  it("rejects a time skipped by daylight saving", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    const draft = taskToDraft({
      ...legacyTask,
      schedule: { type: "once", runAt: "2027-03-14T18:00:00.000Z" },
    });
    expect(scheduleFromDraft({ ...draft, runAt: "2027-03-14T02:30" })).toBeNull();
  });

  it("keeps the saved offset when an edit stays in an hour that repeats", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    // 01:30 PST, the second 01:30 on 2026-11-01.
    const draft = taskToDraft({
      ...legacyTask,
      schedule: { type: "once", runAt: "2026-11-01T09:30:00.000Z" },
    });
    expect(scheduleFromDraft({ ...draft, runAt: "2026-11-01T01:35" })).toEqual({
      type: "once",
      runAt: "2026-11-01T09:35:00.000Z",
    });
  });
});

describe("webhook scheduled tasks", () => {
  const signature = { header: "x-signature", encoding: "base64", prefix: "" } as const;
  const webhookTask: ScheduledTask = {
    ...legacyTask,
    schedule: { type: "webhook", signature },
    webhook: { path: "/api/hooks/legacy-task/token", url: null, hasSecret: true },
  };

  it("round-trips dedupe settings, clears them, and rejects invalid windows", () => {
    const dedupe = {
      replayKey: "{{headers.delivery-id}}",
      coalesceKey: "{{body.id}}",
      coalesceWindowSeconds: 10,
    };
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature: null, dedupe },
    });
    expect(scheduleFromDraft(draft)).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: " \n ",
        coalesceKey: " \t ",
        coalesceWindowSeconds: "",
      }),
    ).toMatchObject({ dedupe: {} });
    expect(
      scheduleFromDraft({
        ...draft,
        replayKey: `  ${dedupe.replayKey}  `,
        coalesceKey: `\t${dedupe.coalesceKey}\n`,
      }),
    ).toMatchObject({ dedupe });
    expect(
      scheduleFromDraft({ ...draft, replayKey: "", coalesceKey: "", coalesceWindowSeconds: "" }),
    ).toMatchObject({ dedupe: {} });
    expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds: "" })).toMatchObject({
      dedupe: { replayKey: dedupe.replayKey, coalesceKey: dedupe.coalesceKey },
    });
    for (const coalesceWindowSeconds of ["9", "3601", "1.5", "abc"]) {
      expect(scheduleFromDraft({ ...draft, coalesceWindowSeconds })).toBeNull();
    }
  });

  it("keeps a stored secret when the secret field is left blank", () => {
    const draft = taskToDraft(webhookTask);
    expect(draft.scheduleMode).toBe("webhook");
    expect(draft.signatureSecret).toBe("");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature,
      maxDeliveryAgeMinutes: null,
      dedupe: {},
    });
    expect(scheduleFromDraft({ ...draft, signatureSecret: " new " })).toEqual({
      type: "webhook",
      signature: { ...signature, secret: "new" },
      maxDeliveryAgeMinutes: null,
      dedupe: {},
    });
  });

  it("round-trips the max age, treats blank as no limit, and rejects an invalid limit", () => {
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: 90 },
    });
    expect(draft.maxDeliveryAgeMinutes).toBe("90");
    expect(scheduleFromDraft(draft)).toMatchObject({ maxDeliveryAgeMinutes: 90 });
    for (const blank of ["", "  "]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: blank })).toMatchObject({
        maxDeliveryAgeMinutes: null,
        dedupe: {},
      });
    }
    for (const invalid of ["0", "-5", "1.5", "abc", "1441"]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: invalid })).toBeNull();
    }
  });

  it("sends filters only when the form changed them", () => {
    const filters = [
      { path: "headers.x-github-event", op: "equals", value: "pull_request" },
      { path: "body.action", op: "in", value: ["opened", "reopened"] },
    ] as const;
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature, filters },
    });
    expect(draft.filters.map((filter) => filter.op)).toEqual(["equals", "in"]);
    // A title-only save leaves the key out, so the server keeps whatever is stored now.
    expect(scheduleFromDraft({ ...draft, title: "Renamed" })).not.toHaveProperty("filters");
    expect(scheduleFromDraft({ ...draft, filters: draft.filters.slice(0, 1) })).toMatchObject({
      filters: filters.slice(0, 1),
    });
    // Removing every row is a change, so it clears the stored filters.
    expect(scheduleFromDraft({ ...draft, filters: [] })).toMatchObject({ filters: [] });
    expect(
      scheduleFromDraft({
        ...draft,
        filters: [{ id: "f1", path: "body.action", op: "in", value: " , " }],
      }),
    ).toBeNull();
  });
});

describe("scheduled task model defaults", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const projectId = ProjectId.make("project");
  const environmentSelection = {
    instanceId,
    model: "environment-model",
    options: [{ id: "reasoning", value: "high" }],
  };
  const projectSelection = { instanceId, model: "project-model" };
  const config = {
    settings: { ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: environmentSelection },
    providers: [
      {
        instanceId,
        driver: "codex",
        displayName: "Codex",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "first-model", name: "First", isCustom: false, capabilities: null },
          {
            slug: "catalog-default",
            name: "Default",
            isDefault: true,
            isCustom: false,
            capabilities: null,
          },
          { slug: "environment-model", name: "Environment", isCustom: false, capabilities: null },
          { slug: "project-model", name: "Project", isCustom: false, capabilities: null },
        ],
      },
    ],
  } as unknown as ServerConfig;
  const resolve = (
    value: ServerConfig,
    project: { id: typeof projectId; defaultModelSelection?: typeof projectSelection } | null,
  ) =>
    scheduledTaskDefaultModel(
      value.settings,
      project,
      deriveProviderInstanceEntries(value.providers),
    );
  it("uses the advertised default instead of catalog order when no default is configured", () => {
    expect(
      resolve({ ...config, settings: { ...config.settings, defaultModelSelection: null } }, null),
    ).toEqual({ instanceId, model: "catalog-default" });
  });
  it("falls back to the environment default when the project provider is unavailable", () => {
    expect(
      resolve(config, {
        id: projectId,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("unavailable"),
          model: "missing",
        },
      }),
    ).toEqual(environmentSelection);
  });
});

it("rejects dedupe templates without a request placeholder", () => {
  const draft = taskToDraft({ ...legacyTask, schedule: { type: "webhook", signature: null } });
  expect(scheduleFromDraft({ ...draft, replayKey: "literal" })).toBeNull();
  expect(scheduleFromDraft({ ...draft, coalesceKey: "{{body.bad" })).toBeNull();
});
