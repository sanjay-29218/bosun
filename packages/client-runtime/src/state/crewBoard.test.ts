import {
  botHeadquartersThreadId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type FeatureCardState,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botNeedsYouKey,
  buildFeatureStageBoard,
  collectNeedsYou,
  countNeedsYouByBot,
  featureCardActions,
  featureDropAction,
  featurePhase,
  featureQueuePositions,
  groupFeaturesByPhase,
  matchesFeatureSearch,
  mostUsedWorkflowId,
  oldestNeedsYouItem,
  ordinal,
  parseFeatureSearch,
  sendBackTargets,
  stageOutcomes,
  stagePhase,
  type EnvironmentFeatureCard,
  type NeedsYouShell,
} from "./crewBoard.ts";

const environmentId = EnvironmentId.make("env-1");
const otherEnvironmentId = EnvironmentId.make("env-2");
const projectId = ProjectId.make("project-1");

const definition: WorkflowDefinition = {
  schemaVersion: 2,
  id: "feature-delivery",
  name: "Feature delivery",
  revision: 3,
  start: "plan",
  roles: {},
  steps: {
    plan: { type: "task", role: "planner", task: "Plan", next: { ready: "design" }, gate: true },
    design: { type: "task", role: "designer", task: "Design", next: { ready: "build" } },
    build: { type: "task", role: "builder", task: "Build", next: { built: "review" } },
    review: {
      type: "task",
      role: "reviewer",
      task: "Review",
      next: { approved: "end", changes_requested: "build" },
      limits: { changes_requested: 3 },
    },
    end: { type: "end" },
  },
  defaults: { questions: "supervisor", failure: "pause", maxStepExecutions: 30 },
};

const card = (
  featureId: string,
  state: FeatureCardState,
  stepId: string | null,
  overrides: Partial<EnvironmentFeatureCard> = {},
): EnvironmentFeatureCard => ({
  environmentId,
  featureId,
  projectId,
  title: `Feature ${featureId}`,
  issue: null,
  workflow: { id: definition.id, name: definition.name, revision: 3, latestRevision: 3 },
  state,
  started: true,
  stateSince: "2026-10-01T00:00:00.000Z",
  stage:
    stepId === null
      ? null
      : {
          stepId,
          index: 1,
          total: 4,
          role: (definition.steps[stepId] as { role?: string } | undefined)?.role ?? "builder",
          attempt: 1,
          gate: false,
          takenOver: false,
        },
  threadId: ThreadId.make(`thread-${featureId}`),
  detail: null,
  yourCall: null,
  queuedAt: null,
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

describe("phases", () => {
  it("reads a stage's phase from its id, then its role", () => {
    expect(stagePhase("plan", "planner")).toBe("plan");
    expect(stagePhase("qa", "qa")).toBe("verify");
    expect(stagePhase("change_review", "manager")).toBe("verify");
    expect(stagePhase("step-4", "designer")).toBe("design");
    expect(stagePhase("merge", "you")).toBe("ship");
    expect(stagePhase("polish", "polisher")).toBe("build");
  });

  it("puts done and cancelled features in Done and groups the rest newest first", () => {
    expect(featurePhase(card("a", "cancelled", "build"))).toBe("done");
    expect(featurePhase(card("b", "working", null))).toBe("plan");
    const groups = groupFeaturesByPhase([
      card("old", "working", "build", { stateSince: "2026-10-01T00:00:00.000Z" }),
      card("new", "failed", "build", { stateSince: "2026-10-02T00:00:00.000Z" }),
      card("done", "done", "review"),
    ]);
    expect(groups.map((group) => group.phase)).toEqual([
      "plan",
      "design",
      "build",
      "verify",
      "ship",
      "done",
    ]);
    expect(groups[2]!.cards.map((item) => item.featureId)).toEqual(["new", "old"]);
    expect(groups[5]!.cards.map((item) => item.featureId)).toEqual(["done"]);
  });
});

describe("workflow stage board", () => {
  it("lays cards under stages, counts gate waits, and hides other workflows", () => {
    const board = buildFeatureStageBoard(definition, [
      card("gated", "approval", "plan"),
      card("building", "working", "build"),
      card("unstarted", "working", null, { started: false }),
      card("shipped", "done", "review"),
      card("legacy", "failed", "polish", {
        workflow: { ...card("x", "working", null).workflow, revision: 2 },
      }),
      card("bug", "working", "fix", {
        workflow: { id: "bug-fix", name: "Bug fix", revision: 1, latestRevision: 1 },
      }),
    ]);
    expect(board.columns.map((column) => column.stepId)).toEqual([
      "plan",
      "design",
      "build",
      "review",
      "polish",
      "done",
    ]);
    const plan = board.columns[0]!;
    expect(plan).toMatchObject({ role: "planner", gate: true, waiting: 1 });
    expect(plan.cards.map((item) => item.featureId).toSorted()).toEqual(["gated", "unstarted"]);
    expect(board.columns[4]).toMatchObject({ onlyInRevision: 2, role: "builder" });
    expect(board.columns[5]!.cards.map((item) => item.featureId)).toEqual(["shipped"]);
    expect(board.hidden).toEqual([{ name: "Bug fix", count: 1 }]);
    expect(board.loops).toEqual([
      { from: "review", to: "build", outcome: "changes_requested", limit: 3 },
    ]);
  });

  it("opens on the workflow most features run", () => {
    const bug = { id: "bug-fix", name: "Bug fix", revision: 1, latestRevision: 1 };
    expect(
      mostUsedWorkflowId([
        card("a", "working", "build", { workflow: bug }),
        card("b", "working", "build", { workflow: bug }),
        card("c", "working", "build"),
      ]),
    ).toBe("bug-fix");
    expect(mostUsedWorkflowId([])).toBeNull();
  });
});

describe("needs you", () => {
  it("groups features and plain threads by kind, oldest first, without doubling stage threads", () => {
    const groups = collectNeedsYou({
      cards: [
        card("gate", "approval", "plan", { stateSince: "2026-10-01T02:00:00.000Z" }),
        card("failed", "failed", "build", { stateSince: "2026-10-01T01:00:00.000Z" }),
        card("asks", "input", "plan", { stateSince: "2026-10-01T03:00:00.000Z" }),
        card("busy", "working", "build"),
        card("paused", "paused", "build"),
        card("queued", "queued", "build"),
      ],
      shells: [
        // The gate card's own stage thread is represented by the card.
        shell("thread-gate", { hasPendingApprovals: true }),
        // A working stage's tool approval is not on its card, so the thread shows.
        shell("thread-busy", {
          hasPendingApprovals: true,
          runtime: { updatedAt: "2026-10-01T00:40:00.000Z" },
        }),
        shell("tool", {
          hasPendingApprovals: true,
          runtime: { updatedAt: "2026-10-01T00:30:00.000Z" },
        }),
        shell("question", { hasPendingUserInput: true }),
        shell("archived", { hasPendingApprovals: true, archivedAt: "2026-10-01T00:00:00.000Z" }),
        shell("idle"),
      ],
    });
    expect(
      groups.map((group) => [group.kind, group.items.map((item) => item.key.split(":")[1])]),
    ).toEqual([
      ["approval", ["tool", "thread-busy", "gate"]],
      ["problem", ["failed"]],
      ["question", ["question", "asks"]],
    ]);
    expect(oldestNeedsYouItem(groups)?.key).toBe("env-1:question");
  });

  it("reads stage threads from their crew summary, then their own requests", () => {
    const crew = (current: boolean, state: FeatureCardState) => ({
      featureId: "remote",
      stepId: "build",
      index: 3,
      total: 4,
      state,
      current,
    });
    const groups = collectNeedsYou({
      cards: [],
      shells: [
        shell("current", { crew: crew(true, "failed") }),
        shell("earlier", { crew: crew(false, "failed") }),
        shell("working", { crew: crew(true, "working"), hasPendingApprovals: true }),
      ],
    });
    expect(groups.map((group) => [group.kind, group.items.map((item) => item.key)])).toEqual([
      ["approval", ["env-1:working"]],
      ["problem", ["env-1:current"]],
    ]);
    expect(oldestNeedsYouItem([])).toBeNull();
  });
});

describe("search", () => {
  it("filters by workflow slug and free text", () => {
    const search = parseFeatureSearch("workflow:Feature-Delivery  kanban");
    expect(search).toEqual({ text: "kanban", workflows: ["feature-delivery"] });
    const kanban = card("k", "working", "build", { title: "Kanban board MVP" });
    expect(matchesFeatureSearch(kanban, search)).toBe(true);
    expect(matchesFeatureSearch(kanban, parseFeatureSearch("workflow:bug-fix"))).toBe(false);
    expect(matchesFeatureSearch(kanban, parseFeatureSearch("bosun builder"), ["bosun"])).toBe(true);
    expect(matchesFeatureSearch(kanban, parseFeatureSearch("missing"))).toBe(false);
  });

  it("finds a feature by its linked issue", () => {
    const linked = card("k", "working", "build", {
      issue: {
        url: "https://github.com/o/r/issues/42",
        number: 42,
        title: "Board shows GitHub issues",
        state: "open",
        milestone: "Beta",
        subIssues: null,
      },
    });
    expect(matchesFeatureSearch(linked, parseFeatureSearch("#42"))).toBe(true);
    expect(matchesFeatureSearch(linked, parseFeatureSearch("github issues"))).toBe(true);
    expect(matchesFeatureSearch(linked, parseFeatureSearch("beta"))).toBe(true);
  });
});

describe("queue, drag and actions", () => {
  it("numbers queued features per environment by when they were queued", () => {
    const positions = featureQueuePositions([
      card("second", "queued", "build", { queuedAt: "2026-10-01T02:00:00.000Z" }),
      card("first", "queued", "build", { queuedAt: "2026-10-01T01:00:00.000Z" }),
      card("elsewhere", "queued", "build", {
        environmentId: otherEnvironmentId,
        queuedAt: "2026-10-01T03:00:00.000Z",
      }),
    ]);
    expect(positions.get("env-1:first")).toBe(1);
    expect(positions.get("env-1:second")).toBe(2);
    expect(positions.get("env-2:elsewhere")).toBe(1);
    expect([1, 2, 3, 4, 11, 22].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "22nd"]);
  });

  it("only cancels into Done and reopens out of it", () => {
    expect(featureDropAction(card("a", "working", "build"), "done")).toBe("cancel");
    expect(featureDropAction(card("a", "working", "build"), "open")).toBeNull();
    expect(featureDropAction(card("a", "done", "review"), "open")).toBe("reopen");
    expect(featureDropAction(card("a", "cancelled", "build"), "done")).toBeNull();
  });

  it("offers each state's way out", () => {
    expect(featureCardActions(card("a", "failed", "build"))).toEqual([
      "retry",
      "take-over",
      "send-back",
      "skip",
      "cancel",
    ]);
    expect(featureCardActions(card("a", "working", null, { started: false }))).toEqual([
      "start",
      "cancel",
    ]);
    expect(featureCardActions(card("a", "cancelled", "build"))).toEqual(["reopen"]);
    expect(featureCardActions(card("a", "queued", "build"))).toContain("start-now");
    const takenOver = card("a", "working", "build");
    expect(
      featureCardActions({ ...takenOver, stage: { ...takenOver.stage!, takenOver: true } }),
    ).toEqual(["mark-done", "retry", "send-back", "cancel"]);
  });

  it("sends back only to stages this run finished", () => {
    const steps = [
      { id: "plan", status: "completed" },
      { id: "design", status: "pending" },
      { id: "build", status: "skipped" },
      { id: "review", status: "failed" },
    ];
    expect(sendBackTargets(definition, steps, "review")).toEqual(["plan", "build"]);
    expect(sendBackTargets(definition, [], "plan")).toEqual([]);
    expect(stageOutcomes(definition, "plan")).toEqual(["ready"]);
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
