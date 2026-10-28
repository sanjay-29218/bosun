import { CAPTAIN_BOT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botDeleteBlocker, groupProjectsByBot, moveBotInOrder, moveBotTo } from "./bots.logic";

describe("groupProjectsByBot", () => {
  it("groups projects by owner in order, with unowned ones under Captain", () => {
    const unowned = { title: "a", botId: undefined };
    const captains = { title: "b", botId: CAPTAIN_BOT_ID };
    const socials = { title: "c", botId: "bot-social" };
    const groups = groupProjectsByBot([unowned, socials, captains]);
    expect(groups.get(CAPTAIN_BOT_ID)).toEqual([unowned, captains]);
    expect(groups.get("bot-social")).toEqual([socials]);
    expect(groups.get("bot-finance")).toBeUndefined();
  });
});

describe("moveBotInOrder", () => {
  const order = ["captain", "social", "finance"];

  it("moves a bot one place and keeps every other bot", () => {
    expect(moveBotInOrder(order, "social", -1)).toEqual(["social", "captain", "finance"]);
    expect(moveBotInOrder(order, "social", 1)).toEqual(["captain", "finance", "social"]);
  });

  it("refuses moves past either end and unknown bots", () => {
    expect(moveBotInOrder(order, "captain", -1)).toBeNull();
    expect(moveBotInOrder(order, "finance", 1)).toBeNull();
    expect(moveBotInOrder(order, "missing", 1)).toBeNull();
  });
});

describe("moveBotTo", () => {
  const order = ["captain", "social", "finance"];

  it("drops a bot where another one is, either way", () => {
    expect(moveBotTo(order, "finance", "captain")).toEqual(["finance", "captain", "social"]);
    expect(moveBotTo(order, "captain", "finance")).toEqual(["social", "finance", "captain"]);
  });

  it("does nothing for a drop on itself or an unknown bot", () => {
    expect(moveBotTo(order, "social", "social")).toBeNull();
    expect(moveBotTo(order, "social", "missing")).toBeNull();
  });
});

describe("botDeleteBlocker", () => {
  it("never allows deleting Captain", () => {
    expect(botDeleteBlocker(CAPTAIN_BOT_ID, 0)).not.toBeNull();
  });

  it("asks for a bot's projects to move first", () => {
    expect(botDeleteBlocker("bot-social", 1)).toBe("Move its project to another bot first.");
    expect(botDeleteBlocker("bot-social", 3)).toBe("Move its 3 projects to another bot first.");
    expect(botDeleteBlocker("bot-social", 0)).toBeNull();
  });
});
