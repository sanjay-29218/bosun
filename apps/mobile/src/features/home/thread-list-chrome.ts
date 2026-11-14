import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";

/**
 * The bot switcher and List / Board toggle every thread-list header shows: the iPhone and
 * iPad native headers, the iPad sidebar, and Android's toolbar.
 */
export interface BotSwitcherMenu {
  /** The active bot's look; null with no bot to show, when the header reads Bots. */
  readonly bot: Pick<LogicalBot, "avatar" | "color"> | null;
  readonly name: string;
  readonly accessibilityLabel: string;
  /** Threads waiting on you under the other bots, which this list doesn't show. */
  readonly elsewhereNeedsYou: number;
  /**
   * The pinned bots to switch to (with `state`), the pinned project managers, Bots (every bot
   * and manager), the active bot's headquarters, then Automations and Library, the web rail's
   * places for scheduled tasks and roles.
   */
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly subtitle?: string;
    readonly state?: "on" | "off";
    readonly onPress: () => void;
  }>;
}

export const needsYouLabel = (count: number) => `${count} need${count === 1 ? "s" : ""} you`;

/** A pinned project manager the switcher opens. */
export interface SwitcherManager {
  readonly key: string;
  readonly title: string;
}

/**
 * The pinned bots to switch between, the pinned project managers, Bots, the active bot's
 * headquarters, Automations and Library. A single bot still gets the button, and so does no bot:
 * the header then reads Bots. An unpinned bot picked from the Bots screen stays active.
 */
export function buildBotSwitcherMenu<Manager extends SwitcherManager>(input: {
  readonly bots: ReadonlyArray<LogicalBot>;
  /** Null when there's no bot to show. */
  readonly active: LogicalBot | null;
  readonly needsYou: ReadonlyMap<string, number>;
  readonly managers: ReadonlyArray<Manager>;
  readonly select: (bot: LogicalBot) => void;
  readonly openHeadquarters: (bot: LogicalBot) => void;
  readonly openManager: (manager: Manager) => void;
  readonly openBotsList: () => void;
  readonly openAutomations: () => void;
  readonly openLibrary: () => void;
}): BotSwitcherMenu {
  const { active } = input;
  const pinned = input.bots.filter((bot) => bot.pinned);
  // A lone pinned bot that is already active has nothing to switch to.
  const switching = pinned.length > 1 || (pinned.length === 1 && pinned[0]!.key !== active?.key);
  let elsewhereNeedsYou = 0;
  for (const bot of input.bots) {
    if (bot.key !== active?.key) elsewhereNeedsYou += input.needsYou.get(bot.key) ?? 0;
  }
  const name = active?.name ?? "Bots";
  const label = active === null ? "Bots" : `Bot: ${name}`;
  return {
    bot: active,
    name,
    accessibilityLabel:
      elsewhereNeedsYou > 0 ? `${label}. ${needsYouLabel(elsewhereNeedsYou)} in other bots` : label,
    elsewhereNeedsYou,
    items: [
      ...(switching
        ? pinned.map((bot) => {
            const count = input.needsYou.get(bot.key) ?? 0;
            return {
              key: bot.key,
              title: bot.name,
              ...(count > 0 ? { subtitle: needsYouLabel(count) } : {}),
              state: bot.key === active?.key ? ("on" as const) : ("off" as const),
              onPress: () => input.select(bot),
            };
          })
        : []),
      ...input.managers.map((manager) => ({
        key: `manager:${manager.key}`,
        title: manager.title,
        subtitle: "Project manager",
        onPress: () => input.openManager(manager),
      })),
      {
        key: "bots",
        title: "Bots",
        subtitle: "All bots and project managers",
        onPress: input.openBotsList,
      },
      ...(active === null
        ? []
        : [
            {
              key: "headquarters",
              title: `Open ${active.name}'s thread`,
              subtitle: "Where it oversees its projects",
              onPress: () => input.openHeadquarters(active),
            },
          ]),
      {
        key: "automations",
        title: "Automations",
        subtitle: "Scheduled tasks",
        onPress: input.openAutomations,
      },
      {
        key: "library",
        title: "Library",
        subtitle: "Roles",
        onPress: input.openLibrary,
      },
    ],
  };
}

export type ThreadListView = "list" | "board";

/** The header button that flips the list column between threads and the feature board. */
export interface ThreadListViewToggle {
  readonly view: ThreadListView;
  readonly onToggle: () => void;
}

/** The button shows where it goes: the board from List, the threads from Board. */
export function threadListViewToggleButton(view: ThreadListView) {
  return view === "list"
    ? ({ icon: "square.split.2x1", accessibilityLabel: "Show board" } as const)
    : ({ icon: "list.bullet", accessibilityLabel: "Show threads" } as const);
}
