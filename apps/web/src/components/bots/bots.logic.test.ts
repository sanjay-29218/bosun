import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId } from "@t3tools/contracts";

import {
  botDeleteBlocker,
  botTransferAutomationsLine,
  botTransferLeftOut,
  groupProjectsByBot,
  moveBotInOrder,
  moveBotTo,
} from "./bots.logic";

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

describe("botTransferAutomationsLine", () => {
  const webhook = { title: "Deploy hook", reason: "New webhook URL on VPS." };
  it("counts what a move keeps on and off, leaving webhooks to their own rows", () => {
    const line = (copied: number, enabled: number) =>
      botTransferAutomationsLine("move", { copied, enabled, needAttention: [webhook] }, "VPS");
    expect(line(5, 4)).toBe("4 go along and stay on.");
    expect(line(2, 0)).toBe("1 goes along, turned off.");
    expect(line(5, 3)).toBe("4 go along. 3 stay on, 1 stays off.");
    expect(line(1, 0)).toBeNull();
  });

  it("says a copy's arrive turned off", () => {
    expect(
      botTransferAutomationsLine("copy", { copied: 4, enabled: 4, needAttention: [] }, "VPS"),
    ).toBe("4 arrive turned off. Turn them on on VPS when you're ready.");
  });
});

describe("botTransferLeftOut", () => {
  it("groups a move's projects left with no bot by machine", () => {
    const mac = EnvironmentId.make("mac");
    const project = (id: string, outcome: "comes-along" | "left-without-bot") => ({
      environmentId: mac,
      environmentLabel: "MacBook",
      projectId: ProjectId.make(id),
      title: id,
      outcome,
    });
    const left = botTransferLeftOut([
      project("notes", "left-without-bot"),
      project("site", "comes-along"),
      project("scripts", "left-without-bot"),
    ]);
    expect(left.count).toBe(2);
    expect(
      left.machines.map((machine) => [machine.label, machine.projects.map((p) => p.title)]),
    ).toEqual([["MacBook", ["notes", "scripts"]]]);
  });
});
