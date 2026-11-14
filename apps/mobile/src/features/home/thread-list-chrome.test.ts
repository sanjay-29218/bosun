import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import { EnvironmentId, type BotAvatar } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildBotSwitcherMenu } from "./thread-list-chrome";

const environmentId = EnvironmentId.make("environment-1");
const bot = (key: string, name: string, eyes: BotAvatar["eyes"], pinned = true): LogicalBot => ({
  key,
  name,
  avatar: { head: "round", eyes, face: "visor", top: "ball", cheeks: false, smile: false },
  color: "blue",
  members: [{ environmentId, botId: key }],
  pinned,
});
const places = {
  managers: [],
  select: vi.fn(),
  openHeadquarters: vi.fn(),
  openManager: vi.fn(),
  openBotsList: vi.fn(),
  openAutomations: vi.fn(),
  openLibrary: vi.fn(),
};
const captain = bot("name:captain", "Captain", "round");
const social = bot("name:social", "Social", "happy");
const finance = bot("name:finance", "Finance", "visor");

describe("buildBotSwitcherMenu", () => {
  it("offers a single bot's headquarters without a switch", () => {
    const openHeadquarters = vi.fn();
    const menu = buildBotSwitcherMenu({
      ...places,
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
      "Bots",
      "Open Captain's thread",
      "Automations",
      "Library",
    ]);
    menu!.items[1]!.onPress();
    expect(openHeadquarters).toHaveBeenCalledWith(captain);
  });

  it("badges what waits under the other bots and lists each bot's count", () => {
    const select = vi.fn();
    const openHeadquarters = vi.fn();
    const menu = buildBotSwitcherMenu({
      ...places,
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
        { title: "Captain", subtitle: "3 need you", state: "on" },
        { title: "Social", subtitle: "1 needs you", state: "off" },
        { title: "Finance", subtitle: "2 need you", state: "off" },
        { title: "Bots", subtitle: "All bots and project managers" },
        { title: "Open Captain's thread" },
        { title: "Automations" },
        { title: "Library" },
      ],
    });
    menu!.items[1]!.onPress();
    expect(select).toHaveBeenCalledWith(social);
    // The item after Bots opens the active bot's headquarters rather than switching.
    menu!.items[4]!.onPress();
    expect(openHeadquarters).toHaveBeenCalledWith(captain);
    expect(menu!.items[4]).not.toHaveProperty("state");
  });

  it("ends with the places: Automations, then Library", () => {
    const openAutomations = vi.fn();
    const openLibrary = vi.fn();
    const menu = buildBotSwitcherMenu({
      ...places,
      bots: [captain, social],
      active: captain,
      needsYou: new Map(),
      select: vi.fn(),
      openHeadquarters: vi.fn(),
      openAutomations,
      openLibrary,
    });
    const [automations, library] = menu!.items.slice(-2);
    expect(automations).toMatchObject({ title: "Automations", subtitle: "Scheduled tasks" });
    expect(library).toMatchObject({ title: "Library", subtitle: "Roles" });
    expect(library).not.toHaveProperty("state");
    automations!.onPress();
    library!.onPress();
    expect(openAutomations).toHaveBeenCalledOnce();
    expect(openLibrary).toHaveBeenCalledOnce();
  });

  it("reads Bots with no bot to show, and still offers the places", () => {
    const menu = buildBotSwitcherMenu({ ...places, bots: [], active: null, needsYou: new Map() });
    expect(menu.bot).toBeNull();
    expect(menu.name).toBe("Bots");
    expect(menu.items.map((item) => item.title)).toEqual(["Bots", "Automations", "Library"]);
  });

  it("lists only pinned bots, then pinned managers, keeping an unpinned active bot", () => {
    const idle = bot("name:idle", "Idle", "sleepy", false);
    const openManager = vi.fn();
    const manager = { key: "env:web", title: "web" };
    const menu = buildBotSwitcherMenu({
      ...places,
      bots: [captain, idle, social],
      active: idle,
      managers: [manager],
      needsYou: new Map(),
      openManager,
    });
    expect(menu.name).toBe("Idle");
    expect(menu.items.map((item) => [item.title, item.state ?? null])).toEqual([
      ["Captain", "off"],
      ["Social", "off"],
      ["web", null],
      ["Bots", null],
      ["Open Idle's thread", null],
      ["Automations", null],
      ["Library", null],
    ]);
    menu.items[2]!.onPress();
    expect(openManager).toHaveBeenCalledWith(manager);
  });

  it("leaves a bot with nothing waiting without a subtitle", () => {
    const menu = buildBotSwitcherMenu({
      ...places,
      bots: [captain, social],
      active: social,
      needsYou: new Map(),
      select: vi.fn(),
      openHeadquarters: vi.fn(),
      openAutomations: vi.fn(),
      openLibrary: vi.fn(),
    });
    expect(menu?.elsewhereNeedsYou).toBe(0);
    expect(menu?.items[0]).not.toHaveProperty("subtitle");
  });
});
