import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMoveToBotMenuItem, parseMoveToBotMenuId } from "./moveProjectToBot";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

const bots = [
  {
    key: "name:captain",
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
    pinned: true,
    members: [
      { environmentId: local, botId: "bot-ops" },
      { environmentId: remote, botId: "bot-ops" },
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
    pinned: true,
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
  it("lists every bot, then No bot, with the owner checked", () => {
    const item = buildMoveToBotMenuItem([member(local, "bot-ops")], bots, botEnvironments);
    expect(item?.label).toBe("Move to bot");
    expect(item?.children?.map((child) => [child.label, child.checked ?? false])).toEqual([
      ["Captain", true],
      ["Social", false],
      ["No bot", false],
    ]);
    const loose = buildMoveToBotMenuItem([member(local)], bots, botEnvironments);
    expect(loose?.children?.map((child) => child.checked ?? false)).toEqual([false, false, true]);
    expect(parseMoveToBotMenuId(loose!.children![2]!.id)?.botKey).toBe("");
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
      "No bot",
    ]);
    expect(buildMoveToBotMenuItem([member(remote)], bots, new Set([local]))).toBeNull();
  });

  it("ignores ids that aren't moves", () => {
    expect(parseMoveToBotMenuId("project-settings")).toBeNull();
    expect(parseMoveToBotMenuId("move-to-bot:menu")).toBeNull();
  });
});
