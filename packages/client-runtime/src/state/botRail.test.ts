import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  type BotAvatar,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botActivityByBot,
  botActivityByLogicalBot,
  botRailShowsThread,
  botRailSignal,
  buildLogicalBots,
  combineBotActivity,
  countNeedsYouByLogicalBot,
  logicalBotHeadquartersKeys,
  logicalBotProjectKeys,
  projectBotId,
  resolveActiveLogicalBot,
  resolveEnvironmentFilter,
  selectLogicalBot,
} from "./botRail.ts";
import { botNeedsYouKey } from "./crewBoard.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const avatar = (eyes: BotAvatar["eyes"]): BotAvatar => ({
  head: "round",
  eyes,
  face: "visor",
  top: "ball",
  cheeks: false,
  smile: false,
});
const bot = (id: string, name: string, position: number, eyes: BotAvatar["eyes"] = "round") => ({
  id,
  name,
  avatar: avatar(eyes),
  color: "blue" as const,
  position,
});

const environments = [
  {
    environmentId: local,
    bots: [bot("bot-social", "Social", 1, "happy"), bot(CAPTAIN_BOT_ID, "Captain", 0, "star")],
  },
  {
    environmentId: remote,
    bots: [
      bot(CAPTAIN_BOT_ID, "Skipper", 0, "visor"),
      bot("bot-finance", "Finance", 1),
      bot("bot-social-2", " social ", 2),
    ],
  },
];

describe("projectBotId", () => {
  it("treats a project without an owner as Captain's", () => {
    expect(projectBotId({})).toBe(CAPTAIN_BOT_ID);
    expect(projectBotId({ botId: "bot-social" })).toBe("bot-social");
  });
});

describe("buildLogicalBots", () => {
  it("merges Captain by id and other bots by name, in priority then rail order", () => {
    const bots = buildLogicalBots(environments);
    expect(bots.map((entry) => [entry.name, entry.avatar.eyes, entry.members.length])).toEqual([
      ["Captain", "star", 2],
      ["Social", "happy", 2],
      ["Finance", "round", 1],
    ]);
    expect(bots[1]!.members).toEqual([
      { environmentId: local, botId: "bot-social" },
      { environmentId: remote, botId: "bot-social-2" },
    ]);
  });
});

describe("buildLogicalBots with a repeated name", () => {
  it("keeps a second same-named bot on one environment as its own entry", () => {
    const bots = buildLogicalBots([
      { environmentId: local, bots: [bot("bot-a", "Social", 0), bot("bot-b", "social", 1)] },
    ]);
    expect(bots.map((entry) => entry.members.map((member) => member.botId))).toEqual([
      ["bot-a"],
      ["bot-b"],
    ]);
    expect(
      logicalBotProjectKeys(bots[1]!, bots, [{ environmentId: local, id: "p", botId: "bot-b" }]),
    ).toEqual(new Set(["local:p"]));
  });
});

describe("resolveActiveLogicalBot", () => {
  const bots = buildLogicalBots(environments);

  it("follows the first environment whose remembered bot still exists", () => {
    expect(
      resolveActiveLogicalBot(bots, { local: "bot-gone", remote: "bot-finance" }, [local, remote])
        ?.name,
    ).toBe("Finance");
  });

  it("reads as All bots when nothing remembered is still listed", () => {
    expect(resolveActiveLogicalBot(bots, {}, [local, remote])).toBeNull();
    expect(resolveActiveLogicalBot(bots, { local: "bot-gone" }, [local, remote])).toBeNull();
    expect(resolveActiveLogicalBot([], {}, [local])).toBeNull();
  });

  it("always selects a lone bot, which has no All bots beside it", () => {
    const [captain] = bots;
    expect(resolveActiveLogicalBot([captain!], {}, [local])?.name).toBe("Captain");
  });

  it("selects All bots by forgetting every environment's bot", () => {
    const next = selectLogicalBot({ local: "bot-social", remote: "bot-social-2" }, null);
    expect(next).toEqual({});
    expect(resolveActiveLogicalBot(bots, next, [local, remote])).toBeNull();
  });

  it("remembers the bot on each of its environments", () => {
    const next = selectLogicalBot({ local: CAPTAIN_BOT_ID, other: "bot-x" }, bots[1]!);
    expect(next).toEqual({ local: "bot-social", remote: "bot-social-2" });
    expect(resolveActiveLogicalBot(bots, next, [local, remote])?.name).toBe("Social");
  });

  it("selects a bot that only a later environment has", () => {
    const finance = bots.find((entry) => entry.name === "Finance")!;
    const next = selectLogicalBot({ local: CAPTAIN_BOT_ID, remote: CAPTAIN_BOT_ID }, finance);
    expect(resolveActiveLogicalBot(bots, next, [local, remote])?.name).toBe("Finance");
  });
});

describe("logicalBotProjectKeys", () => {
  const bots = buildLogicalBots(environments);
  const projects = [
    { environmentId: local, id: "a", botId: "bot-social" },
    { environmentId: remote, id: "b", botId: "bot-social-2" },
    { environmentId: remote, id: "c" },
    // An owner the rail hasn't loaded yet stays visible under Captain.
    { environmentId: local, id: "d", botId: "bot-unknown" },
  ];

  it("selects the projects each entry owns across environments", () => {
    expect([...logicalBotProjectKeys(bots[1]!, bots, projects)]).toEqual(["local:a", "remote:b"]);
    expect([...logicalBotProjectKeys(bots[0]!, bots, projects)]).toEqual(["remote:c", "local:d"]);
  });
});

describe("countNeedsYouByLogicalBot", () => {
  it("sums member counts per entry", () => {
    const bots = buildLogicalBots(environments);
    const counts = countNeedsYouByLogicalBot(
      bots,
      new Map([
        [botNeedsYouKey(local, "bot-social"), 2],
        [botNeedsYouKey(remote, "bot-social-2"), 1],
        [botNeedsYouKey(remote, CAPTAIN_BOT_ID), 4],
      ]),
    );
    expect(counts.get(bots[1]!.key)).toBe(3);
    expect(counts.get(bots[0]!.key)).toBe(4);
    expect(counts.get(bots[2]!.key)).toBeUndefined();
  });
});

describe("resolveEnvironmentFilter", () => {
  it("narrows to connected selected environments", () => {
    expect(resolveEnvironmentFilter(null, [local, remote])).toBeNull();
    expect([...resolveEnvironmentFilter(["remote"], [local, remote])!]).toEqual([remote]);
  });

  it("reads as all when nothing selected is connected, or everything is", () => {
    expect(resolveEnvironmentFilter(["gone"], [local, remote])).toBeNull();
    expect(resolveEnvironmentFilter([], [local])).toBeNull();
    expect(resolveEnvironmentFilter(["local", "remote"], [local, remote])).toBeNull();
  });
});

describe("botRailShowsThread", () => {
  it("shows a bot's own headquarters under it, whatever project holds it", () => {
    const [captain, social] = buildLogicalBots([
      {
        environmentId: local,
        bots: [bot(CAPTAIN_BOT_ID, "Captain", 0), bot("bot-social", "Social", 1)],
      },
    ]);
    const thread = (id: string, projectId: string) => ({ environmentId: local, id, projectId });
    const socialProjects = new Set([`${local}:p-social`]);
    const socialHeadquarters = logicalBotHeadquartersKeys(social!);
    const show = (target: ReturnType<typeof thread>) =>
      botRailShowsThread(target, socialProjects, socialHeadquarters);

    // Headquarters sit in Scratch, a project neither bot's filter lists.
    expect(show(thread(botHeadquartersThreadId("bot-social"), "scratch"))).toBe(true);
    expect(show(thread(botHeadquartersThreadId(CAPTAIN_BOT_ID), "scratch"))).toBe(false);
    expect(show(thread("plain", "p-social"))).toBe(true);
    expect(show(thread("plain", "p-captain"))).toBe(false);
    // A hidden environment's headquarters stays hidden.
    const [shared] = buildLogicalBots([
      { environmentId: local, bots: [bot(CAPTAIN_BOT_ID, "Captain", 0)] },
      { environmentId: remote, bots: [bot(CAPTAIN_BOT_ID, "Captain", 0)] },
    ]);
    expect([...logicalBotHeadquartersKeys(shared!, new Set([local]))]).toEqual([
      `${local}:${botHeadquartersThreadId(CAPTAIN_BOT_ID)}`,
    ]);
    // Without a picked bot, project keys alone decide.
    expect(
      botRailShowsThread(
        thread(botHeadquartersThreadId(captain!.members[0]!.botId), "s"),
        null,
        null,
      ),
    ).toBe(true);
  });
});

describe("bot activity", () => {
  const [captain, social] = buildLogicalBots([
    {
      environmentId: local,
      bots: [bot(CAPTAIN_BOT_ID, "Captain", 0), bot("bot-social", "Social", 1)],
    },
  ]);
  const projects = [
    { environmentId: local, id: ProjectId.make("p-captain") },
    { environmentId: local, id: ProjectId.make("p-social"), botId: "bot-social" },
  ];
  const runId = RunId.make("run-1");
  const shell = (
    id: string,
    projectId: string,
    run: { status: "running" | "completed" | "failed"; completedAt: string | null } | null,
    lastVisitedAt: string | null | undefined,
  ) => ({
    environmentId: local,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    archivedAt: null,
    lastVisitedAt,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default" as const,
    latestRun:
      run === null
        ? null
        : {
            runId,
            status: run.status,
            requestedAt: null,
            startedAt: null,
            completedAt: run.completedAt,
            assistantMessageId: null,
          },
    runtime:
      run?.status === "running"
        ? {
            status: "running" as const,
            activeRunId: runId,
            providerInstanceId: "codex" as never,
            providerName: null,
            lastError: null,
            updatedAt: "2026-10-01T00:00:00.000Z",
          }
        : null,
  });
  const before = "2026-10-01T00:00:00.000Z";
  const after = "2026-10-01T01:00:00.000Z";

  it("flags failed, working and unread threads under their bot", () => {
    const activity = botActivityByBot(
      [
        shell("failed", "p-social", { status: "failed", completedAt: after }, before),
        shell("working", "p-captain", { status: "running", completedAt: null }, before),
        shell("done", "p-captain", { status: "completed", completedAt: after }, before),
        // Opened since it finished: nothing to flag.
        shell("seen", "p-social", { status: "completed", completedAt: before }, after),
      ],
      projects,
    );
    // A failed run is also an unread one; the signal shows the failure.
    expect(activity.get(botNeedsYouKey(local, "bot-social"))).toEqual({
      failed: true,
      working: false,
      unread: true,
    });
    expect(activity.get(botNeedsYouKey(local, CAPTAIN_BOT_ID))).toEqual({
      failed: false,
      working: true,
      unread: true,
    });
  });

  it("counts a headquarters under its own bot, and nothing from servers without visits", () => {
    const activity = botActivityByBot(
      [
        shell(
          botHeadquartersThreadId("bot-social"),
          "scratch",
          { status: "completed", completedAt: after },
          before,
        ),
        shell("old-server", "p-captain", { status: "failed", completedAt: after }, undefined),
      ],
      projects,
    );
    expect([...activity.keys()]).toEqual([botNeedsYouKey(local, "bot-social")]);
  });

  it("merges per rail entry and across entries for All bots", () => {
    const perEntry = botActivityByLogicalBot(
      [captain!, social!],
      new Map([
        [botNeedsYouKey(local, "bot-social"), { failed: false, working: true, unread: false }],
        [botNeedsYouKey(local, "bot-unknown"), { failed: false, working: false, unread: true }],
      ]),
    );
    // A bot the rail doesn't know falls under Captain, like its projects.
    expect(perEntry.get(captain!.key)).toEqual({ failed: false, working: false, unread: true });
    expect(combineBotActivity(perEntry.values())).toEqual({
      failed: false,
      working: true,
      unread: true,
    });
    expect(combineBotActivity([])).toBeUndefined();
  });

  it("shows one signal, the most urgent", () => {
    const everything = { failed: true, working: true, unread: true };
    expect(botRailSignal(2, everything)).toEqual({ kind: "needs-you", count: 2 });
    expect(botRailSignal(0, everything)).toEqual({ kind: "failed" });
    expect(botRailSignal(0, { ...everything, failed: false })).toEqual({ kind: "working" });
    expect(botRailSignal(0, { failed: false, working: false, unread: true })).toEqual({
      kind: "unread",
    });
    expect(botRailSignal(0, undefined)).toBeNull();
  });
});
