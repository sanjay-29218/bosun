import { botRailSignal, type BotActivity } from "@t3tools/client-runtime/state/bot-rail";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface BotListRowSummary {
  /** What the row marks, matching the rail icon: waiting on you wins over working. */
  readonly mark: "needs-you" | "working" | null;
  /** A finished run you haven't seen, with nothing else to mark. */
  readonly unread: boolean;
  readonly preview: string;
  /** When its standing thread's last message landed, as ISO; null with no messages. */
  readonly time: string | null;
}

/** One bot list row: the bot's rail signal and its headquarters' last line. */
export function botListRowSummary(
  needsYou: number,
  activity: BotActivity | undefined,
  latestMessage: OrchestrationV2ThreadShell["latestVisibleMessage"] | undefined,
): BotListRowSummary {
  const signal = botRailSignal(needsYou, activity);
  const mark = signal?.kind === "needs-you" || signal?.kind === "working" ? signal.kind : null;
  const unread = signal?.kind === "unread";
  if (!latestMessage) return { mark, unread, preview: "No messages yet", time: null };
  return {
    mark,
    unread,
    // The server names a message's attachment when it has no text; this covers older servers.
    preview: latestMessage.text || "Attachment",
    time: DateTime.formatIso(latestMessage.updatedAt),
  };
}
