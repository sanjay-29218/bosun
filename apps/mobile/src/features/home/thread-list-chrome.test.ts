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
      openAutomations: vi.fn(),
      openLibrary: vi.fn(),
    });
    expect(menu?.elsewhereNeedsYou).toBe(0);
    expect(menu?.items.map((item) => item.title)).toEqual([
      "Open Captain's thread",
      "Automations",
      "Library",
    ]);
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
      openAutomations: vi.fn(),
      openLibrary: vi.fn(),
    });

    expect(menu).toMatchObject({
      name: "Captain",
      elsewhereNeedsYou: 3,
      accessibilityLabel: "Bot: Captain. 3 need you in other bots",
      items: [
        { title: "All bots", subtitle: "6 need you", state: "off" },
        { title: "Captain", subtitle: "3 need you", state: "on" },
        { title: "Social", subtitle: "1 needs you", state: "off" },
        { title: "Finance", subtitle: "2 need you", state: "off" },
        { title: "Open Captain's thread" },
        { title: "Automations" },
        { title: "Library" },
      ],
    });
    menu!.items[2]!.onPress();
    expect(select).toHaveBeenCalledWith(social);
    // The last item opens the active bot's headquarters rather than switching.
    menu!.items[4]!.onPress();
    expect(openHeadquarters).toHaveBeenCalledWith(captain);
    expect(menu!.items[4]).not.toHaveProperty("state");
  });

  it("shows All bots with nothing elsewhere and no headquarters", () => {
    const select = vi.fn();
    const menu = buildBotSwitcherMenu({
      bots: [captain, social],
      active: null,
      needsYou: new Map([[social.key, 1]]),
      select,
      openHeadquarters: vi.fn(),
      openAutomations: vi.fn(),
      openLibrary: vi.fn(),
    });
    expect(menu).toMatchObject({
      bot: null,
      name: "All bots",
      elsewhereNeedsYou: 0,
      items: [
        { title: "All bots", subtitle: "1 needs you", state: "on" },
        { title: "Captain", state: "off" },
        { title: "Social", state: "off" },
        { title: "Automations" },
        { title: "Library" },
      ],
    });
    menu!.items[0]!.onPress();
    expect(select).toHaveBeenCalledWith(null);
  });

  it("ends with the places: Automations, then Library", () => {
    const openAutomations = vi.fn();
    const openLibrary = vi.fn();
    const menu = buildBotSwitcherMenu({
      bots: [captain, social],
      active: null,
      needsYou: new Map(),
      select: vi.fn(),
      openHeadquarters: vi.fn(),
      openAutomations,
      openLibrary,
    });
    const [automations, library] = menu!.items.slice(-2);
    expect(automations).toMatchObject({ title: "Automations", subtitle: "Scheduled tasks" });
    expect(library).toMatchObject({ title: "Library", subtitle: "Workflows and roles" });
    expect(library).not.toHaveProperty("state");
    automations!.onPress();
    library!.onPress();
    expect(openAutomations).toHaveBeenCalledOnce();
    expect(openLibrary).toHaveBeenCalledOnce();
  });

  it("has no menu before any bot loads", () => {
    expect(
      buildBotSwitcherMenu({
        bots: [],
        active: null,
        needsYou: new Map(),
        select: vi.fn(),
        openHeadquarters: vi.fn(),
        openAutomations: vi.fn(),
        openLibrary: vi.fn(),
      }),
    ).toBeNull();
  });

  it("leaves a bot with nothing waiting without a subtitle", () => {
    const menu = buildBotSwitcherMenu({
      bots: [captain, social],
      active: social,
      needsYou: new Map(),
      select: vi.fn(),
      openHeadquarters: vi.fn(),
      openAutomations: vi.fn(),
      openLibrary: vi.fn(),
    });
    expect(menu?.elsewhereNeedsYou).toBe(0);
    expect(menu?.items[1]).not.toHaveProperty("subtitle");
  });
});
