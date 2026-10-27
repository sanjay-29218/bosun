import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import type { BotAvatar, ProjectIconColor } from "@t3tools/contracts";

/**
 * The bot switcher and List / Board toggle every thread-list header shows: the iPhone and
 * iPad native headers, the iPad sidebar, and Android's toolbar.
 */
export interface BotSwitcherMenu {
  readonly avatar: BotAvatar;
  readonly color: ProjectIconColor;
  readonly name: string;
  readonly accessibilityLabel: string;
  /** Threads waiting on you under the other bots, which this list doesn't show. */
  readonly elsewhereNeedsYou: number;
  /** The bots to switch to (with `state`), then an action that opens the active bot. */
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly subtitle?: string;
    readonly state?: "on" | "off";
    readonly onPress: () => void;
  }>;
}

export const needsYouLabel = (count: number) => `${count} need${count === 1 ? "s" : ""} you`;

/**
 * The bots to switch between, then the active bot's headquarters. A single bot still gets the
 * button, for its headquarters; null only before any bot loads.
 */
export function buildBotSwitcherMenu(input: {
  readonly bots: ReadonlyArray<LogicalBot>;
  readonly active: LogicalBot | null;
  readonly needsYou: ReadonlyMap<string, number>;
  readonly select: (bot: LogicalBot) => void;
  readonly openHeadquarters: (bot: LogicalBot) => void;
}): BotSwitcherMenu | null {
  const { active } = input;
  if (active === null) return null;
  const switching = input.bots.length > 1;
  let elsewhereNeedsYou = 0;
  for (const bot of input.bots) {
    if (bot.key !== active.key) elsewhereNeedsYou += input.needsYou.get(bot.key) ?? 0;
  }
  return {
    avatar: active.avatar,
    color: active.color,
    name: active.name,
    accessibilityLabel:
      elsewhereNeedsYou > 0
        ? `Bot: ${active.name}. ${needsYouLabel(elsewhereNeedsYou)} in other bots`
        : `Bot: ${active.name}`,
    elsewhereNeedsYou,
    items: [
      ...(switching
        ? input.bots.map((bot) => {
            const count = input.needsYou.get(bot.key) ?? 0;
            return {
              key: bot.key,
              title: bot.name,
              ...(count > 0 ? { subtitle: needsYouLabel(count) } : {}),
              state: bot.key === active.key ? ("on" as const) : ("off" as const),
              onPress: () => input.select(bot),
            };
          })
        : []),
      {
        key: "headquarters",
        title: `Open ${active.name}'s thread`,
        subtitle: "Where it oversees its projects",
        onPress: () => input.openHeadquarters(active),
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
