import { botRailSignal, type BotActivity } from "@t3tools/client-runtime/state/bot-rail";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface AllBotsRowSummary {
  /** What the row marks, matching the rail icon: waiting on you wins over working. */
  readonly mark: "needs-you" | "working" | null;
  readonly preview: string;
  /** When its headquarters' last message landed, as ISO; null with no messages. */
  readonly time: string | null;
}

/** One All bots row: the bot's rail signal and its headquarters' last line. */
export function allBotsRowSummary(
  needsYou: number,
  activity: BotActivity | undefined,
  latestMessage: OrchestrationV2ThreadShell["latestVisibleMessage"] | undefined,
): AllBotsRowSummary {
  const signal = botRailSignal(needsYou, activity);
  const message = latestMessage?.text ? latestMessage : null;
  return {
    mark: signal?.kind === "needs-you" || signal?.kind === "working" ? signal.kind : null,
    preview: message?.text ?? "No messages yet",
    time: message === null ? null : DateTime.formatIso(message.updatedAt),
  };
}
