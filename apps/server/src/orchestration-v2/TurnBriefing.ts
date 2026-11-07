import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface TurnBriefingShape {
  /** Text the thread's agent reads before the message that starts a new provider conversation. */
  readonly forThread: (threadId: ThreadId) => Effect.Effect<string | null>;
}

/**
 * Optional. Lets a thread open with no turn of its own and still brief its agent: the briefing
 * rides along with whichever message starts the conversation.
 */
export class TurnBriefing extends Context.Service<TurnBriefing, TurnBriefingShape>()(
  "t3/orchestration-v2/TurnBriefing",
) {}
