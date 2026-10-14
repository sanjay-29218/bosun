import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildBotSwitcherMenu } from "./thread-list-chrome";

const environmentId = EnvironmentId.make("environment-1");
const bot = (key: string, name: string, emoji: string): LogicalBot => ({
  key,
  name,
  emoji,
  members: [{ environmentId, botId: key }],
});
const captain = bot("id:bot-captain", "Captain", "🧭");
const social = bot("name:social", "Social", "📣");
const finance = bot("name:finance", "Finance", "💰");

describe("buildBotSwitcherMenu", () => {
  it("keeps the header unchanged with a single bot", () => {
    expect(
      buildBotSwitcherMenu({
        bots: [captain],
        active: captain,
        needsYou: new Map([[captain.key, 2]]),
        select: vi.fn(),
      }),
    ).toBeNull();
  });

  it("badges what waits under the other bots and lists each bot's count", () => {
    const select = vi.fn();
    const menu = buildBotSwitcherMenu({
      bots: [captain, social, finance],
      active: captain,
      needsYou: new Map([
        [captain.key, 3],
        [social.key, 1],
        [finance.key, 2],
      ]),
      select,
    });

    expect(menu).toMatchObject({
      emoji: "🧭",
      elsewhereNeedsYou: 3,
      accessibilityLabel: "Bot: Captain. 3 need you in other bots",
      items: [
        { title: "🧭 Captain", subtitle: "3 need you", state: "on" },
        { title: "📣 Social", subtitle: "1 needs you", state: "off" },
        { title: "💰 Finance", subtitle: "2 need you", state: "off" },
      ],
    });
    menu!.items[1]!.onPress();
    expect(select).toHaveBeenCalledWith(social);
  });

  it("leaves a bot with nothing waiting without a subtitle", () => {
    const menu = buildBotSwitcherMenu({
      bots: [captain, social],
      active: social,
      needsYou: new Map(),
      select: vi.fn(),
    });
    expect(menu?.elsewhereNeedsYou).toBe(0);
    expect(menu?.items[0]).not.toHaveProperty("subtitle");
  });
});
