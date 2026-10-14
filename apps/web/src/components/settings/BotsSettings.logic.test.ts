import { CAPTAIN_BOT_ID } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botDeleteBlocker, countProjectsByBot, moveBotInOrder } from "./BotsSettings.logic";

describe("countProjectsByBot", () => {
  it("counts projects per owner, including unowned ones for Captain", () => {
    const counts = countProjectsByBot([{}, { botId: CAPTAIN_BOT_ID }, { botId: "bot-social" }]);
    expect(counts.get(CAPTAIN_BOT_ID)).toBe(2);
    expect(counts.get("bot-social")).toBe(1);
    expect(counts.get("bot-finance")).toBeUndefined();
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
