import { CAPTAIN_BOT_ID, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botMoveTarget, buildMoveToBotMenuItem, parseMoveToBotMenuId } from "./moveProjectToBot";

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

const botEnvironments = new Set([local, remote]);

describe("buildMoveToBotMenuItem", () => {
  it("lists every bot with the owner checked", () => {
    const item = buildMoveToBotMenuItem([member(local)], bots, botEnvironments);
    expect(item?.label).toBe("Move to bot");
    expect(item?.children?.map((child) => [child.label, child.checked ?? false])).toEqual([
      ["Captain", true],
      ["Social", false],
    ]);
    expect(parseMoveToBotMenuId(item!.children![1]!.id)).toEqual({
      environmentId: local,
      projectId: "p",
      botKey: "name:social",
    });
  });

  it("offers bots an environment doesn't have yet, and nothing where bots don't run", () => {
    // Social is only on this Mac; moving the server's checkout to it creates it there.
    const item = buildMoveToBotMenuItem(
      [member(local, "bot-social"), member(remote)],
      bots,
      botEnvironments,
    );
    expect(item?.children?.map((child) => child.label)).toEqual(["This Mac", "Server"]);
    expect(item?.children?.[1]?.children?.map((child) => child.label)).toEqual([
      "Captain",
      "Social",
    ]);
    expect(buildMoveToBotMenuItem([member(remote)], bots, new Set([local]))).toBeNull();
  });

  it("ignores ids that aren't moves", () => {
    expect(parseMoveToBotMenuId("project-settings")).toBeNull();
    expect(parseMoveToBotMenuId("move-to-bot:menu")).toBeNull();
  });
});

describe("botMoveTarget", () => {
  const social = bots[1]!;
  const newId = () => "bot-new";

  it("creates a missing bot under a new id when its id is taken there by another bot", () => {
    // The server's copy of Social was renamed, so it's another bot now, and its id is taken.
    const there = [
      { id: CAPTAIN_BOT_ID, name: "Captain" },
      { id: "bot-social", name: "Outreach" },
    ];
    expect(botMoveTarget(social, remote, there, newId)).toEqual({ create: "bot-new" });
  });

  it("reuses a bot with the same name that appeared there since", () => {
    const there = [{ id: "bot-social-made-there", name: "Social" }];
    expect(botMoveTarget(social, remote, there, newId)).toEqual({
      botId: "bot-social-made-there",
    });
  });

  it("never creates Captain, which every environment has", () => {
    expect(botMoveTarget(bots[0]!, EnvironmentId.make("elsewhere"), [], newId)).toEqual({
      botId: CAPTAIN_BOT_ID,
    });
  });
});
