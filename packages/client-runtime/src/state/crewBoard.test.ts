import {
  botHeadquartersThreadId,
  EnvironmentId,
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
  featureCardActions,
  featureCardKey,
  featureColumn,
  featureDropAction,
  featureFinished,
  featureOpenThreadId,
  featureRef,
  groupFeaturesByColumn,
  matchesFeatureSearch,
  nestFeatureChildren,
  oldestNeedsYouItem,
  threadBoardColumn,
  threadsByFeature,
  type BoardThreadShell,
  type EnvironmentFeatureCard,
  type NeedsYouShell,
} from "./crewBoard.ts";
import type { EnvironmentThreadShell } from "./models.ts";

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
    expect(oldestNeedsYouItem(groups)?.shell.id).toBe("question");
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
  it("only closes into Done and reopens out of it", () => {
    expect(featureDropAction(card("a"), "done")).toBe("close");
    expect(featureDropAction(card("a"), "open")).toBeNull();
    expect(featureDropAction(card("a", { status: "closed" }), "open")).toBe("reopen");
    expect(featureDropAction(card("a", { status: "closed" }), "done")).toBeNull();
  });

  it("offers Start until the lead has its thread, and Reopen once closed", () => {
    expect(featureCardActions(card("a", { leadThreadId: null }))).toEqual(["start", "close"]);
    expect(featureCardActions(card("a"))).toEqual(["close"]);
    expect(featureCardActions(card("a", { status: "closed" }))).toEqual(["reopen"]);
  });
});

describe("countNeedsYouByBot", () => {
  it("counts waiting threads under the bot that owns their project", () => {
    const social = ProjectId.make("social-site");
    const captains = ProjectId.make("legacy");
    const other = EnvironmentId.make("env-2");
    const counts = countNeedsYouByBot(
      [
        { ...shell("approval", { hasPendingApprovals: true }), projectId: social },
        { ...shell("question", { hasPendingUserInput: true }), projectId: social },
        { ...shell("idle"), projectId: social },
        { ...shell("older-server", { hasPendingApprovals: true }), projectId: captains },
        {
          ...shell("elsewhere", { hasPendingApprovals: true, environmentId: other }),
          projectId: social,
        },
      ],
      [
        { environmentId, id: social, botId: "bot:social" },
        // A project from an older server has no botId: Captain owns it.
        { environmentId, id: captains },
        { environmentId: other, id: social, botId: "bot:social" },
      ],
    );
    expect(Object.fromEntries(counts)).toEqual({
      [botNeedsYouKey(environmentId, "bot:social")]: 2,
      [botNeedsYouKey(environmentId, "bot-captain")]: 1,
      [botNeedsYouKey(other, "bot:social")]: 1,
    });
  });

  it("counts a headquarters under its own bot, not the project it lives in", () => {
    const scratch = ProjectId.make("scratch");
    const counts = countNeedsYouByBot(
      [
        {
          ...shell(botHeadquartersThreadId("bot:social"), { hasPendingApprovals: true }),
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
