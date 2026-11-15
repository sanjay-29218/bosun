import { describe, expect, it } from "vite-plus/test";

import { botDeleteBlocker, groupProjectsByBot, moveBotInOrder, moveBotTo } from "./bots.logic";

describe("groupProjectsByBot", () => {
  it("groups projects by owner in order, with unowned ones under null", () => {
    const unowned = { title: "a", botId: undefined };
    const loose = { title: "b", botId: null };
    const socials = { title: "c", botId: "bot-social" };
    const groups = groupProjectsByBot([unowned, socials, loose]);
    expect(groups.get(null)).toEqual([unowned, loose]);
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
  it("asks for a bot's projects to be unlinked first", () => {
    expect(botDeleteBlocker(1)).toBe("Unlink its project first.");
    expect(botDeleteBlocker(3)).toBe("Unlink its 3 projects first.");
    expect(botDeleteBlocker(0)).toBeNull();
  });
});
