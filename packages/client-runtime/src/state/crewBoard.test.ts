import {
  botHeadquartersThreadId,
  EnvironmentId,
  projectHeadquartersThreadId,
  RunId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botNeedsYouKey,
  collectNeedsYou,
  countNeedsYouByBot,
  countNeedsYouByProject,
  featureCardActions,
  featureCardKey,
  featureColumn,
  featureFinished,
  chatWorkGroup,
  featureOpenThreadId,
  featureProgress,
  featureWorkGroup,
  featureWorkStatus,
  WORK_ROW_LABELS,
  groupFeaturesByWork,
  featureRef,
  groupFeaturesByColumn,
  matchesFeatureSearch,
  nestFeatureChildren,
  oldestAsk,
  threadAsksYou,
  threadBoardColumn,
  threadsByFeature,
  type AskShell,
  type BoardThreadShell,
  type EnvironmentFeatureCard,
  type NeedsYouShell,
} from "./crewBoard.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import type { ThreadPullRequestLink } from "@t3tools/contracts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

const card = (
  featureId: string,
  overrides: Partial<EnvironmentFeatureCard> = {},
): EnvironmentFeatureCard => ({
  environmentId,
  featureId,
  projectId,
  title: `Feature ${featureId}`,
  issue: null,
  status: "open",
  leadThreadId: ThreadId.make(`lead-${featureId}`),
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const shell = (
  id: string,
  overrides: Partial<NeedsYouShell> = {},
): NeedsYouShell & { readonly title: string } => ({
  environmentId,
  id: ThreadId.make(id),
  title: id,
  archivedAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  updatedAt: "2026-10-01T00:00:00.000Z",
  runtime: null,
  ...overrides,
});

const runtime = (status: OrchestrationV2RunStatus | "idle") => ({
  status,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: null,
  lastError: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
});

/** A thread of feature `featureId`: its lead, or the crew member `member`. */
const featureThread = (
  id: string,
  featureId: string,
  fields: Partial<BoardThreadShell> = {},
  member?: string,
): BoardThreadShell & Pick<EnvironmentThreadShell, "feature"> => ({
  ...shell(id),
  pendingSubagentRequest: null,
  runtime: null,
  feature: { id: featureId, title: featureId, ...(member ? { member } : {}) },
  ...fields,
});

describe("status columns", () => {
  it("files a feature by its lead's and crew's threads, with the longest wait first", () => {
    const cards = [
      card("unstarted", { leadThreadId: null }),
      card("building"),
      card("asking"),
      card("reported", { updatedAt: "2026-09-30T00:00:00.000Z" }),
      card("closed", { status: "closed" }),
    ];
    const threads = threadsByFeature([
      featureThread("lead-building", "building"),
      featureThread("builder", "building", { runtime: runtime("running") }, "Builder"),
      featureThread("lead-asking", "asking", { hasPendingUserInput: true }),
      featureThread("planner", "asking", { runtime: runtime("running") }, "Planner"),
      featureThread("lead-reported", "reported", {
        runtime: runtime("idle"),
        updatedAt: "2026-09-30T00:00:00.000Z",
      }),
      featureThread("lead-closed", "closed", { runtime: runtime("running") }),
    ]);
    expect(
      groupFeaturesByColumn(cards, threads).map((group) => [
        group.column,
        group.cards.map((item) => item.featureId),
      ]),
    ).toEqual([
      ["todo", ["unstarted"]],
      ["working", ["building"]],
      ["needs-you", ["reported", "asking"]],
      ["done", ["closed"]],
    ]);
  });

  it("nests child features under their top parent, whose column follows its open children", () => {
    const cards = [
      card("epic"),
      card("shell", { parentFeatureId: "epic", number: 2 }),
      card("recording", { parentFeatureId: "shell", number: 3 }),
      card("export", { parentFeatureId: "epic", number: 4, status: "closed" }),
      card("stray", { parentFeatureId: "not-on-this-board" }),
    ];
    const nested = nestFeatureChildren(
      cards,
      threadsByFeature([
        featureThread("lead-epic", "epic", { runtime: runtime("idle") }),
        featureThread("lead-recording", "recording", { runtime: runtime("running") }),
        featureThread("lead-export", "export", { hasPendingUserInput: true }),
      ]),
    );
    expect(nested.cards.map((item) => item.featureId)).toEqual(["epic", "stray"]);
    expect(nested.children.get(featureCardKey(cards[0]!))?.map((item) => item.featureId)).toEqual([
      "shell",
      "recording",
      "export",
    ]);
    // A grandchild runs, so the epic works; its closed child's question no longer counts.
    expect(
      groupFeaturesByColumn(nested.cards, nested.threads).map((group) => [
        group.column,
        group.cards.map((item) => item.featureId),
      ]),
    ).toEqual([
      ["todo", []],
      ["working", ["epic"]],
      ["needs-you", ["stray"]],
      ["done", []],
    ]);
    // A child's own column still reads only its own threads.
    expect(featureColumn(cards[1]!, nested.threads.get(featureCardKey(cards[1]!)) ?? [])).toBe(
      "needs-you",
    );

    // A closed parent can't hold an open child, which would hide it in Done.
    const closedParent = nestFeatureChildren(
      [card("epic", { status: "closed" }), card("shell", { parentFeatureId: "epic" })],
      new Map(),
    );
    expect(closedParent.cards.map((item) => item.featureId)).toEqual(["epic", "shell"]);
    expect(closedParent.children.size).toBe(0);
  });

  it("reads a lead's report from its latest run as finished, and a child's as done", () => {
    const lead = (runId: string) =>
      featureThread("lead-f", "f", {
        runtime: runtime("idle"),
        latestRun: { runId, status: "completed" } as never,
      });
    const report = { outcome: "finished" as const, runId: "run-2" };
    const child = card("f", { parentFeatureId: "epic", report });
    expect(featureFinished(child, [lead("run-2")])).toBe(true);
    expect(featureColumn(child, [lead("run-2")])).toBe("done");
    // A later run, or a quiet note instead of a report, isn't finished work.
    expect(featureColumn(child, [lead("run-3")])).toBe("needs-you");
    expect(
      featureFinished(card("f", { report: { outcome: "stopped", runId: "run-2" } }), [
        lead("run-2"),
      ]),
    ).toBe(false);
    // A top-level feature that reported waits for the person to review it.
    expect(featureColumn(card("f", { report }), [lead("run-2")])).toBe("needs-you");
  });

  it("names a feature's status: Needs input, Working, Waiting, Done or Failed", () => {
    const report = { outcome: "finished" as const, runId: "run-2" };
    const lead = (fields: Partial<BoardThreadShell>) => featureThread("lead-f", "f", fields);
    const statusOf = (
      threads: ReadonlyArray<BoardThreadShell>,
      overrides: Partial<EnvironmentFeatureCard> = {},
    ) => featureProgress(card("f", overrides), threads).status;
    const stopped = {
      runtime: runtime("idle"),
      latestRun: { runId: "run-2", status: "completed" },
    };

    expect(statusOf([], { leadThreadId: null })).toBe("not-started");
    expect(statusOf([lead({ runtime: runtime("running") })])).toBe("working");
    expect(statusOf([lead({ hasPendingApprovals: true })])).toBe("needs-input");
    expect(statusOf([lead({ pendingSubagentRequest: "user_input" })])).toBe("needs-input");
    // A lead that stopped with the feature unfinished is Waiting, not the person's turn.
    expect(statusOf([lead(stopped as never)])).toBe("waiting");
    expect(statusOf([lead(stopped as never)], { report })).toBe("done");
    expect(statusOf([lead({ latestRun: { runId: "run-2", status: "failed" } } as never)])).toBe(
      "failed",
    );
    expect(statusOf([lead(stopped as never)], { status: "closed" })).toBe("done");
  });

  it("opens the thread asking you something, longest wait first, else the lead", () => {
    const at = (minute: number) => ({
      ...runtime("idle"),
      updatedAt: `2026-10-01T00:0${minute}:00.000Z`,
    });
    const lead = featureThread("lead-f", "f", { pendingSubagentRequest: "approval" });
    const builder = featureThread(
      "builder",
      "f",
      { hasPendingApprovals: true, runtime: at(5) },
      "Builder",
    );
    const planner = featureThread(
      "planner",
      "f",
      { hasPendingUserInput: true, runtime: at(2) },
      "Planner",
    );
    expect(featureOpenThreadId(card("f"), [lead, builder, planner])).toBe("planner");
    expect(featureOpenThreadId(card("f"), [lead, builder])).toBe("builder");
    expect(
      featureOpenThreadId(card("f"), [
        { ...planner, archivedAt: "2026-10-02T00:00:00.000Z" },
        featureThread("qa", "f", { runtime: runtime("running") }, "QA Tester"),
      ]),
    ).toBe("lead-f");
    expect(featureOpenThreadId(card("f", { leadThreadId: null }), [])).toBeNull();
  });

  it("leaves archived threads out of where a feature stands", () => {
    const archived = featureThread("lead", "f", {
      archivedAt: "2026-10-02T00:00:00.000Z",
      runtime: runtime("running"),
    });
    expect(featureColumn(card("f"), [archived])).toBe("needs-you");
  });

  it("files a chat under Needs you, Working or Done, as its sidebar row reads", () => {
    const chat = (
      overrides: Partial<NeedsYouShell> = {},
      fields: Partial<Pick<EnvironmentThreadShell, "pendingSubagentRequest" | "runtime">> = {},
    ) => ({ ...shell("chat", overrides), pendingSubagentRequest: null, runtime: null, ...fields });
    expect(
      threadBoardColumn(chat({ hasPendingUserInput: true }, { runtime: runtime("running") })),
    ).toBe("needs-you");
    expect(threadBoardColumn(chat({}, { pendingSubagentRequest: "approval" }))).toBe("needs-you");
    expect(threadBoardColumn(chat({}, { runtime: runtime("queued") }))).toBe("working");
    expect(threadBoardColumn(chat({}, { runtime: runtime("waiting") }))).toBe("working");
    expect(threadBoardColumn(chat({}, { runtime: runtime("failed") }))).toBe("done");
    expect(threadBoardColumn(chat({}, { runtime: runtime("idle") }))).toBe("done");
    expect(threadBoardColumn(chat())).toBe("done");
  });
});

describe("work groups", () => {
  const pr = (state: "open" | "closed" | "merged"): ThreadPullRequestLink =>
    ({
      host: "github.com",
      repository: "o/r",
      number: 7,
      url: "https://github.com/o/r/pull/7",
      source: "agent",
      linkedAt: "2026-10-01T00:00:00.000Z",
      snapshot: {
        state,
        title: "PR",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-10-01T00:00:00.000Z",
      },
      stack: null,
    }) as ThreadPullRequestLink;
  const stopped = { runtime: runtime("idle"), latestRun: { runId: "run-1", status: "completed" } };
  const lead = (fields: object) =>
    featureThread("lead-f", "f", { ...stopped, ...fields } as Partial<BoardThreadShell>);

  it.each([
    ["a merged PR", { pullRequests: [pr("merged")] }, {}, "done"],
    ["an open PR", { pullRequests: [pr("open")] }, {}, "review"],
    [
      "an open PR on a running turn",
      { pullRequests: [pr("open")], runtime: runtime("running") },
      {},
      "working",
    ],
    [
      "a merged PR on a running turn",
      { pullRequests: [pr("merged")], runtime: runtime("running") },
      {},
      "working",
    ],
    [
      "a question, even with a PR open",
      { pullRequests: [pr("open")], hasPendingUserInput: true },
      {},
      "needs-input",
    ],
    ["a PR closed without merging", { pullRequests: [pr("closed")] }, {}, "working"],
    [
      "a PR whose state isn't known yet",
      { linkedPullRequest: { number: 7, url: "u" } },
      {},
      "review",
    ],
    ["a lead that stopped short", {}, {}, "working"],
    [
      "a lead that reported it finished",
      {},
      { report: { outcome: "finished", runId: "run-1" } },
      "review",
    ],
    ["a feature the person closed without a PR", {}, { status: "closed" }, "review"],
    [
      "a closed feature with an open PR",
      { pullRequests: [pr("open")] },
      { status: "closed" },
      "review",
    ],
    [
      "a closed feature with a merged PR",
      { pullRequests: [pr("merged")] },
      { status: "closed" },
      "done",
    ],
    ["a running closed feature", { runtime: runtime("running") }, { status: "closed" }, "working"],
  ] as const)("files %s under %s", (_, fields, overrides, group) => {
    expect(featureWorkGroup(card("f", overrides as never), [lead(fields)])).toBe(group);
  });

  it("says Done only for merged work; a finished feature without one is Ready for review", () => {
    const report = { outcome: "finished" as const, runId: "run-1" };
    const statusOf = (fields: object, overrides: object = {}) =>
      featureWorkStatus(card("f", overrides as never), [lead(fields)]).status;
    expect(statusOf({}, { report })).toBe("review");
    expect(statusOf({ pullRequests: [pr("merged")] }, { report })).toBe("done");
    expect(statusOf({})).toBe("waiting");
    expect(statusOf({ latestRun: { runId: "run-1", status: "failed" } })).toBe("failed");
    expect(statusOf({ runtime: runtime("running") })).toBe("working");
    expect(statusOf({ hasPendingUserInput: true })).toBe("needs-input");
    // A child that reported finished hands its parent work to review, not merged work.
    expect(statusOf({}, { report, parentFeatureId: "epic" })).toBe("review");
    // A feature nobody started, such as an Epic's queued child, isn't working.
    const queued = featureWorkStatus(card("f", { leadThreadId: null }), []);
    expect(queued.status).toBe("not-started");
    expect(WORK_ROW_LABELS[queued.status]).toBe("Not started");
    // Closed before anyone started it, it still never started.
    expect(featureWorkStatus(card("f", { leadThreadId: null, status: "closed" }), []).status).toBe(
      "not-started",
    );
    expect(WORK_ROW_LABELS.done).toBe("Done");
  });

  it("files chats by their PR, and leaves features not started out of Work", () => {
    const chat = (fields: object) => featureThread("c", "c", fields as Partial<BoardThreadShell>);
    expect(chatWorkGroup(chat({ pullRequests: [pr("open")] }))).toBe("review");
    expect(chatWorkGroup(chat({ pullRequests: [pr("merged")] }))).toBe("done");
    expect(chatWorkGroup(chat({ pullRequests: [pr("closed")] }))).toBe("working");
    expect(chatWorkGroup(chat({}))).toBe("working");
    expect(chatWorkGroup(chat({ hasPendingApprovals: true }))).toBe("needs-input");
    const groups = groupFeaturesByWork(
      [card("f"), card("todo", { leadThreadId: null })],
      new Map([[featureCardKey(card("f")), [lead({ pullRequests: [pr("open")] })]]]),
    );
    expect(groups.map((group) => [group.group, group.cards.map((c) => c.featureId)])).toEqual([
      ["needs-input", []],
      ["working", []],
      ["review", ["f"]],
      ["done", []],
    ]);
  });
});

describe("needs you", () => {
  it("lists waiting threads by kind, oldest first", () => {
    const groups = collectNeedsYou([
      shell("late-approval", { hasPendingApprovals: true, updatedAt: "2026-10-03" }),
      shell("question", { hasPendingUserInput: true, updatedAt: "2026-10-01" }),
      shell("early-approval", { hasPendingApprovals: true, updatedAt: "2026-10-02" }),
      shell("archived", { hasPendingApprovals: true, archivedAt: "2026-10-04" }),
      shell("idle"),
    ]);
    expect(groups.map((group) => [group.kind, group.items.map((item) => item.shell.id)])).toEqual([
      ["approval", ["early-approval", "late-approval"]],
      ["question", ["question"]],
    ]);
  });
});

describe("search", () => {
  it("finds a feature by its linked issue", () => {
    const linked = card("k", {
      issue: {
        url: "https://github.com/o/r/issues/42",
        number: 42,
        title: "Board shows GitHub issues",
        state: "open",
        milestone: "Beta",
        subIssues: null,
      },
    });
    expect(matchesFeatureSearch(linked, "#42")).toBe(true);
    expect(matchesFeatureSearch(linked, "github issues")).toBe(true);
    expect(matchesFeatureSearch(linked, "beta")).toBe(true);
    expect(matchesFeatureSearch(linked, "alpha")).toBe(false);
  });

  it("names a feature by its linked issue, else its own number", () => {
    const numbered = card("k", { number: 3 });
    expect(featureRef(numbered)).toBe("F-3");
    expect(matchesFeatureSearch(numbered, "f-3")).toBe(true);
    expect(featureRef(card("k"))).toBeNull();
    const issue = {
      url: "https://github.com/o/r/issues/42",
      number: 42,
      title: "Board shows GitHub issues",
      state: "open" as const,
      milestone: null,
      subIssues: null,
    };
    expect(featureRef(card("k", { number: 3, issue }))).toBe("#42");
  });
});

describe("drag and actions", () => {
  it("offers Start until the lead has its thread, and Reopen once closed", () => {
    expect(featureCardActions(card("a", { leadThreadId: null }))).toEqual(["start", "close"]);
    expect(featureCardActions(card("a"))).toEqual(["close"]);
    expect(featureCardActions(card("a", { status: "closed" }))).toEqual(["reopen"]);
  });
});

const askShell = (
  id: string,
  overrides: Partial<AskShell> = {},
): AskShell & { readonly projectId: ProjectId } => ({
  ...shell(id),
  projectId,
  runtime: null,
  lineage: { relationshipToParent: null },
  interactionMode: "default",
  hasActionableProposedPlan: false,
  latestRun: null,
  ...overrides,
});
const settledRun = {
  runId: RunId.make("run-1"),
  status: "completed" as const,
};
const planReady: Partial<AskShell> = {
  interactionMode: "plan",
  hasActionableProposedPlan: true,
  latestRun: settledRun,
};
const nestedSubagent: Partial<AskShell> = {
  lineage: { relationshipToParent: "subagent" },
};

describe("countNeedsYouByBot", () => {
  it("counts waiting threads under the bot that owns their project", () => {
    const social = ProjectId.make("social-site");
    const loose = ProjectId.make("loose");
    const other = EnvironmentId.make("env-2");
    const counts = countNeedsYouByBot(
      [
        { ...askShell("approval", { hasPendingApprovals: true }), projectId: social },
        { ...askShell("question", { hasPendingUserInput: true }), projectId: social },
        { ...askShell("idle"), projectId: social },
        { ...askShell("no-bot", { hasPendingApprovals: true }), projectId: loose },
        {
          ...askShell("elsewhere", { hasPendingApprovals: true, environmentId: other }),
          projectId: social,
        },
      ],
      [
        { environmentId, id: social, botId: "bot:social" },
        // A project with no bot counts for no bot.
        { environmentId, id: loose },
        { environmentId: other, id: social, botId: "bot:social" },
      ],
    );
    expect(Object.fromEntries(counts)).toEqual({
      [botNeedsYouKey(environmentId, "bot:social")]: 2,
      [botNeedsYouKey(other, "bot:social")]: 1,
    });
  });

  it("counts a headquarters under its own bot, not the project it lives in", () => {
    const scratch = ProjectId.make("scratch");
    const counts = countNeedsYouByBot(
      [
        {
          ...askShell(botHeadquartersThreadId("bot:social"), { hasPendingApprovals: true }),
          projectId: scratch,
        },
      ],
      [{ environmentId, id: scratch }],
    );
    expect(Object.fromEntries(counts)).toEqual({
      [botNeedsYouKey(environmentId, "bot:social")]: 1,
    });
  });
});

describe("threadAsksYou", () => {
  it("counts an approval, a question and a plan ready for review", () => {
    expect(threadAsksYou(askShell("approval", { hasPendingApprovals: true }))).toBe(true);
    expect(threadAsksYou(askShell("question", { hasPendingUserInput: true }))).toBe(true);
    expect(threadAsksYou(askShell("plan", planReady))).toBe(true);
    expect(threadAsksYou(askShell("idle"))).toBe(false);
  });

  it("waits for the plan's run to settle", () => {
    expect(
      threadAsksYou(
        askShell("planning", { ...planReady, latestRun: { ...settledRun, status: "running" } }),
      ),
    ).toBe(false);
    expect(
      threadAsksYou(askShell("no-plan", { ...planReady, hasActionableProposedPlan: false })),
    ).toBe(false);
    expect(
      threadAsksYou(askShell("default-mode", { ...planReady, interactionMode: "default" })),
    ).toBe(false);
  });

  it("leaves a nested subagent's plain question to its coordinator", () => {
    expect(
      threadAsksYou(askShell("child-question", { ...nestedSubagent, hasPendingUserInput: true })),
    ).toBe(false);
    expect(
      threadAsksYou(
        askShell("child-user-only", {
          ...nestedSubagent,
          hasPendingUserInput: true,
          pendingUserInputUserOnly: true,
        }),
      ),
    ).toBe(true);
    expect(
      threadAsksYou(askShell("child-approval", { ...nestedSubagent, hasPendingApprovals: true })),
    ).toBe(true);
    // A subagent handed to another project is listed there and asks the person itself.
    expect(
      threadAsksYou(
        askShell("listed-child", {
          lineage: { relationshipToParent: "subagent", listed: true },
          hasPendingUserInput: true,
        }),
      ),
    ).toBe(true);
  });

  it("never counts a child's rolled-up ask or an archived thread", () => {
    expect(threadAsksYou(askShell("lead", { pendingSubagentRequest: "approval" }))).toBe(false);
    expect(
      threadAsksYou(
        askShell("archived", { hasPendingApprovals: true, archivedAt: "2026-10-02T00:00:00.000Z" }),
      ),
    ).toBe(false);
  });
});

describe("oldestAsk", () => {
  it("opens the ask that has waited longest, plan reviews included", () => {
    expect(
      oldestAsk([
        askShell("late-approval", { hasPendingApprovals: true, updatedAt: "2026-10-03" }),
        askShell("plan", { ...planReady, updatedAt: "2026-10-02" }),
        // Its coordinator answers it, so ⌘⇧Y skips it as the badge does.
        askShell("child-question", {
          ...nestedSubagent,
          hasPendingUserInput: true,
          updatedAt: "2026-10-01",
        }),
        askShell("idle", { updatedAt: "2026-09-01" }),
      ])?.id,
    ).toBe("plan");
    expect(oldestAsk([askShell("idle")])).toBeNull();
  });
});

describe("asks per bot and project", () => {
  const owned = [{ environmentId, id: projectId, botId: "bot:social" }];

  it("counts a plan ready for review, and a crew ask once though its lead rolls it up", () => {
    const counts = countNeedsYouByBot(
      [
        askShell("plan", planReady),
        askShell("lead", { pendingSubagentRequest: "approval" }),
        askShell("crew", { ...nestedSubagent, hasPendingApprovals: true }),
      ],
      owned,
    );
    expect(Object.fromEntries(counts)).toEqual({
      [botNeedsYouKey(environmentId, "bot:social")]: 2,
    });
  });

  it("leaves a project manager's ask to the manager", () => {
    const counts = countNeedsYouByBot(
      [askShell(projectHeadquartersThreadId(projectId), { hasPendingApprovals: true })],
      owned,
    );
    expect(counts.size).toBe(0);
  });

  it("counts asks per project, the manager's own and projects with no bot included", () => {
    const loose = ProjectId.make("loose");
    const counts = countNeedsYouByProject([
      askShell(projectHeadquartersThreadId(projectId), { hasPendingUserInput: true }),
      askShell("plan", planReady),
      askShell("idle"),
      { ...askShell("loose", { hasPendingApprovals: true }), projectId: loose },
      {
        ...askShell("loose-child", { ...nestedSubagent, hasPendingUserInput: true }),
        projectId: loose,
      },
    ]);
    expect(Object.fromEntries(counts)).toEqual({
      [`${environmentId}:${projectId}`]: 2,
      [`${environmentId}:${loose}`]: 1,
    });
  });
});
