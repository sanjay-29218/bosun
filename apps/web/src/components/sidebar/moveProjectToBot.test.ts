import { CAPTAIN_BOT_ID, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMoveToBotMenuItem, parseMoveToBotMenuId } from "./moveProjectToBot";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const bots = [
  {
    key: "id:bot-captain",
    name: "Captain",
    avatar: {
      head: "squircle",
      eyes: "round",
      face: "visor",
      top: "ball",
      cheeks: false,
      smile: true,
    } as const,
    color: "blue" as const,
    members: [
      { environmentId: local, botId: CAPTAIN_BOT_ID },
      { environmentId: remote, botId: CAPTAIN_BOT_ID },
    ],
  },
  {
    key: "name:social",
    name: "Social",
    avatar: {
      head: "round",
      eyes: "happy",
      face: "plate",
      top: "bow",
      cheeks: true,
      smile: false,
    } as const,
    color: "pink" as const,
    members: [{ environmentId: local, botId: "bot-social" }],
  },
];

const member = (environmentId: EnvironmentId, botId?: string) => ({
  environmentId,
  id: ProjectId.make("p"),
  title: "bosun",
  environmentLabel: environmentId === local ? "This Mac" : "Server",
  ...(botId ? { botId } : {}),
});

describe("buildMoveToBotMenuItem", () => {
  it("lists the environment's bots with the owner checked", () => {
    const item = buildMoveToBotMenuItem([member(local)], bots);
    expect(item?.label).toBe("Move to bot");
    expect(item?.children?.map((child) => [child.label, child.checked ?? false])).toEqual([
      ["Captain", true],
      ["Social", false],
    ]);
    expect(parseMoveToBotMenuId(item!.children![1]!.id)).toEqual({
      environmentId: local,
      projectId: "p",
      botId: "bot-social",
    });
  });

  it("splits by checkout and skips checkouts with nowhere to go", () => {
    const item = buildMoveToBotMenuItem([member(local, "bot-social"), member(remote)], bots);
    expect(item?.children?.map((child) => child.label)).toEqual(["This Mac"]);
    expect(buildMoveToBotMenuItem([member(remote)], bots)).toBeNull();
  });

  it("ignores ids that aren't moves", () => {
    expect(parseMoveToBotMenuId("project-settings")).toBeNull();
    expect(parseMoveToBotMenuId("move-to-bot:menu")).toBeNull();
  });
});
