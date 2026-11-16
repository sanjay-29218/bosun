import { logicalBotOf } from "@t3tools/client-runtime/state/bot-rail";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMoveToBotMenuItem,
  type MoveProjectMember,
  parseMoveToBotMenuId,
} from "./moveProjectToBot";

const studio = EnvironmentId.make("studio");
const macbook = EnvironmentId.make("macbook");
const labels = new Map([
  [studio, "Mac Studio"],
  [macbook, "MacBook"],
]);

const look = {
  avatar: { head: "round", eyes: "happy", face: "plate", top: "bow", cheeks: true, smile: false },
  color: "pink",
  pinned: true,
} as const;
const atlas = logicalBotOf(studio, {
  ...look,
  id: "bot-atlas",
  name: "Atlas",
  position: 0,
  linkedEnvironmentIds: [macbook],
});
const scout = logicalBotOf(studio, { ...look, id: "bot-scout", name: "Scout", position: 1 });
const juno = logicalBotOf(macbook, { ...look, id: "bot-juno", name: "Juno", position: 0 });

const member = (
  environmentId: EnvironmentId,
  owner: { readonly botId?: string; readonly remoteFrom?: EnvironmentId } = {},
): MoveProjectMember => ({
  environmentId,
  id: ProjectId.make("p"),
  title: "marketing-site",
  environmentLabel: labels.get(environmentId) ?? null,
  botId: owner.botId ?? null,
  remoteBot:
    owner.remoteFrom === undefined
      ? null
      : {
          environmentId: owner.remoteFrom,
          botId: "bot-atlas",
          name: "Atlas",
          homeLabel: "Mac Studio",
        },
});

const botEnvironments = new Set([studio, macbook]);
const shown = (
  items:
    | ReadonlyArray<{
        label: string;
        checked?: boolean;
        disabled?: boolean;
        detail?: string;
        header?: boolean;
      }>
    | undefined,
) =>
  items?.map((item) =>
    [item.header ? "#" : "", item.label, item.checked ? "✓" : "", item.detail ?? ""]
      .join("")
      .trim(),
  );

describe("buildMoveToBotMenuItem", () => {
  it("lists one machine's bots flat, then No bot, with the owner checked", () => {
    const item = buildMoveToBotMenuItem(
      [member(studio, { botId: "bot-atlas" })],
      [atlas, scout],
      botEnvironments,
      labels,
    );
    expect(item?.label).toBe("Move to bot");
    expect(shown(item?.children)).toEqual(["Atlas✓", "Scout", "No bot"]);
    const loose = buildMoveToBotMenuItem([member(studio)], [atlas, scout], botEnvironments, labels);
    expect(shown(loose?.children)).toEqual(["Atlas", "Scout", "No bot✓"]);
    expect(parseMoveToBotMenuId(loose!.children![2]!.id)?.botKey).toBe("");
    expect(parseMoveToBotMenuId(item!.children![1]!.id)).toEqual({
      environmentId: studio,
      projectId: "p",
      botKey: scout.key,
    });
  });

  it("groups bots under their home, the project's own first, and disables ones not allowed there", () => {
    // marketing-site on the MacBook belongs to Atlas from the Mac Studio.
    const item = buildMoveToBotMenuItem(
      [member(macbook, { remoteFrom: studio })],
      [atlas, scout, juno],
      botEnvironments,
      labels,
    );
    expect(shown(item?.children)).toEqual([
      "#MacBook",
      "Juno",
      "#Mac Studio",
      "Atlas✓",
      "ScoutNot allowed on MacBook",
      "No bot",
    ]);
    expect(item?.children?.find((child) => child.label === "Scout")?.disabled).toBe(true);
    expect(parseMoveToBotMenuId(item!.children![0]!.id)).toBeNull();
    expect(
      buildMoveToBotMenuItem([member(macbook)], [atlas], new Set([studio]), labels),
    ).toBeNull();
  });

  it("ignores ids that aren't moves", () => {
    expect(parseMoveToBotMenuId("move-to-bot:menu")).toBeNull();
    expect(parseMoveToBotMenuId("delete")).toBeNull();
  });
});
