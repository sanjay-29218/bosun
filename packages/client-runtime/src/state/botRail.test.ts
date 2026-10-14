import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  EnvironmentId,
  type BotAvatar,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  botRailShowsThread,
  buildLogicalBots,
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

  it("falls back to the first entry", () => {
    expect(resolveActiveLogicalBot(bots, {}, [local, remote])?.name).toBe("Captain");
    expect(resolveActiveLogicalBot([], {}, [local])).toBeNull();
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
