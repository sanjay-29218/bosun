import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";

/**
 * The bot switcher and List / Board toggle every thread-list header shows: the iPhone and
 * iPad native headers, the iPad sidebar, and Android's toolbar.
 */
export interface BotSwitcherMenu {
  readonly emoji: string;
  readonly name: string;
  readonly accessibilityLabel: string;
  /** Threads waiting on you under the other bots, which this list doesn't show. */
  readonly elsewhereNeedsYou: number;
  readonly items: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly subtitle?: string;
    readonly state: "on" | "off";
    readonly onPress: () => void;
  }>;
}

export const needsYouLabel = (count: number) => `${count} need${count === 1 ? "s" : ""} you`;

/** Null with fewer than two bots: one bot keeps the header as it was. */
export function buildBotSwitcherMenu(input: {
  readonly bots: ReadonlyArray<LogicalBot>;
  readonly active: LogicalBot | null;
  readonly needsYou: ReadonlyMap<string, number>;
  readonly select: (bot: LogicalBot) => void;
}): BotSwitcherMenu | null {
  const { active } = input;
  if (input.bots.length < 2 || active === null) return null;
  let elsewhereNeedsYou = 0;
  for (const bot of input.bots) {
    if (bot.key !== active.key) elsewhereNeedsYou += input.needsYou.get(bot.key) ?? 0;
  }
  return {
    emoji: active.emoji,
    name: active.name,
    accessibilityLabel:
      elsewhereNeedsYou > 0
        ? `Bot: ${active.name}. ${needsYouLabel(elsewhereNeedsYou)} in other bots`
        : `Bot: ${active.name}`,
    elsewhereNeedsYou,
    items: input.bots.map((bot) => {
      const count = input.needsYou.get(bot.key) ?? 0;
      return {
        key: bot.key,
        title: `${bot.emoji} ${bot.name}`,
        ...(count > 0 ? { subtitle: needsYouLabel(count) } : {}),
        state: bot.key === active.key ? "on" : "off",
        onPress: () => input.select(bot),
      };
    }),
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
    ? ({ icon: "square.3.layers.3d", accessibilityLabel: "Show board" } as const)
    : ({ icon: "list.bullet", accessibilityLabel: "Show threads" } as const);
}
