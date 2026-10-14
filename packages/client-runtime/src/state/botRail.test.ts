import { CAPTAIN_BOT_ID, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildLogicalBots,
  countNeedsYouByLogicalBot,
  logicalBotProjectKeys,
  projectBotId,
  resolveActiveLogicalBot,
  resolveEnvironmentFilter,
  selectLogicalBot,
} from "./botRail.ts";
import { botNeedsYouKey } from "./crewBoard.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const bot = (id: string, name: string, position: number, emoji = "🤖") => ({
  id,
  name,
  emoji,
  position,
});

const environments = [
  {
    environmentId: local,
    bots: [bot("bot-social", "Social", 1, "📣"), bot(CAPTAIN_BOT_ID, "Captain", 0, "⚓")],
  },
  {
    environmentId: remote,
    bots: [
      bot(CAPTAIN_BOT_ID, "Skipper", 0, "🚢"),
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
    expect(bots.map((entry) => [entry.name, entry.emoji, entry.members.length])).toEqual([
      ["Captain", "⚓", 2],
      ["Social", "📣", 2],
      ["Finance", "🤖", 1],
    ]);
    expect(bots[1]!.members).toEqual([
      { environmentId: local, botId: "bot-social" },
      { environmentId: remote, botId: "bot-social-2" },
    ]);
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
