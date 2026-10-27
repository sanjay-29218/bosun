import type { LogicalBot } from "@t3tools/client-runtime/state/bot-rail";

/**
 * The bot switcher and List / Board toggle every thread-list header shows: the iPhone and
 * iPad native headers, the iPad sidebar, and Android's toolbar.
 */
export interface BotSwitcherMenu {
  /** The active bot's look, or null for All bots. */
  readonly bot: Pick<LogicalBot, "avatar" | "color"> | null;
  readonly name: string;
  readonly accessibilityLabel: string;
  /** Threads waiting on you under the other bots, which this list doesn't show. */
  readonly elsewhereNeedsYou: number;
  /**
   * All bots and each bot to switch to (with `state`), then the active bot's headquarters,
   * then Automations, the web rail's place for scheduled tasks.
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

/**
 * All bots and the bots to switch between, then the active bot's headquarters and Automations.
 * A single bot still gets the button; null only before any bot loads.
 */
export function buildBotSwitcherMenu(input: {
  readonly bots: ReadonlyArray<LogicalBot>;
  /** Null is All bots. */
  readonly active: LogicalBot | null;
  readonly needsYou: ReadonlyMap<string, number>;
  readonly select: (bot: LogicalBot | null) => void;
  readonly openHeadquarters: (bot: LogicalBot) => void;
  readonly openAutomations: () => void;
}): BotSwitcherMenu | null {
  const { active } = input;
  if (input.bots.length === 0) return null;
  const switching = input.bots.length > 1;
  let totalNeedsYou = 0;
  let elsewhereNeedsYou = 0;
  for (const bot of input.bots) {
    const count = input.needsYou.get(bot.key) ?? 0;
    totalNeedsYou += count;
    if (active !== null && bot.key !== active.key) elsewhereNeedsYou += count;
  }
  const name = active?.name ?? "All bots";
  return {
    bot: active,
    name,
    accessibilityLabel:
      elsewhereNeedsYou > 0
        ? `Bot: ${name}. ${needsYouLabel(elsewhereNeedsYou)} in other bots`
        : `Bot: ${name}`,
    elsewhereNeedsYou,
    items: [
      ...(switching
        ? [
            {
              key: "all-bots",
              title: "All bots",
              ...(totalNeedsYou > 0 ? { subtitle: needsYouLabel(totalNeedsYou) } : {}),
              state: active === null ? ("on" as const) : ("off" as const),
              onPress: () => input.select(null),
            },
          ]
        : []),
      ...(switching
        ? input.bots.map((bot) => {
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
