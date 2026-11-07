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
  const mark = signal?.kind === "needs-you" || signal?.kind === "working" ? signal.kind : null;
  if (!latestMessage) return { mark, preview: "No messages yet", time: null };
  return {
    mark,
    // The server names a message's attachment when it has no text; this covers older servers.
    preview: latestMessage.text || "Attachment",
    time: DateTime.formatIso(latestMessage.updatedAt),
  };
}
