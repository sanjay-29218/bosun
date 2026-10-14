import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import { EnvironmentId, type BotAvatar } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildBotSwitcherMenu } from "./thread-list-chrome";

const environmentId = EnvironmentId.make("environment-1");
const bot = (key: string, name: string, eyes: BotAvatar["eyes"]): LogicalBot => ({
  key,
  name,
  avatar: { head: "round", eyes, face: "visor", top: "ball", cheeks: false, smile: false },
  color: "blue",
  members: [{ environmentId, botId: key }],
});
const captain = bot("id:bot-captain", "Captain", "round");
const social = bot("name:social", "Social", "happy");
const finance = bot("name:finance", "Finance", "visor");

describe("buildBotSwitcherMenu", () => {
  it("offers a single bot's headquarters without a switch", () => {
    const openHeadquarters = vi.fn();
    const menu = buildBotSwitcherMenu({
      bots: [captain],
      active: captain,
      needsYou: new Map([[captain.key, 2]]),
      select: vi.fn(),
      openHeadquarters,
    });
    expect(menu?.elsewhereNeedsYou).toBe(0);
    expect(menu?.items.map((item) => item.title)).toEqual(["Open Captain's thread"]);
    menu!.items[0]!.onPress();
    expect(openHeadquarters).toHaveBeenCalledWith(captain);
  });

  it("badges what waits under the other bots and lists each bot's count", () => {
    const select = vi.fn();
    const openHeadquarters = vi.fn();
    const menu = buildBotSwitcherMenu({
      bots: [captain, social, finance],
      active: captain,
      needsYou: new Map([
        [captain.key, 3],
        [social.key, 1],
        [finance.key, 2],
      ]),
      select,
      openHeadquarters,
    });

    expect(menu).toMatchObject({
      name: "Captain",
      elsewhereNeedsYou: 3,
      accessibilityLabel: "Bot: Captain. 3 need you in other bots",
      items: [
        { title: "Captain", subtitle: "3 need you", state: "on" },
        { title: "Social", subtitle: "1 needs you", state: "off" },
        { title: "Finance", subtitle: "2 need you", state: "off" },
        { title: "Open Captain's thread" },
      ],
    });
    menu!.items[1]!.onPress();
    expect(select).toHaveBeenCalledWith(social);
    // The last item opens the active bot's headquarters rather than switching.
    menu!.items[3]!.onPress();
    expect(openHeadquarters).toHaveBeenCalledWith(captain);
    expect(menu!.items[3]).not.toHaveProperty("state");
  });

  it("leaves a bot with nothing waiting without a subtitle", () => {
    const menu = buildBotSwitcherMenu({
      bots: [captain, social],
      active: social,
      needsYou: new Map(),
      select: vi.fn(),
      openHeadquarters: vi.fn(),
    });
    expect(menu?.elsewhereNeedsYou).toBe(0);
    expect(menu?.items[0]).not.toHaveProperty("subtitle");
  });
});
