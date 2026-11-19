import type { WorkRowStatus } from "@t3tools/client-runtime/state/crew-board";

/** A feature's status, and whether one of its threads is asking the person something. */
export interface NowState {
  readonly status: WorkRowStatus;
  readonly asks: boolean;
}

export type ParentHeadline =
  | "own-asks"
  | "children-need-you"
  | "own-working"
  | "children-working"
  | "own-turn"
  | "settled";

/**
 * What a parent's hover card leads with. Anything waiting on the person comes first, its own
 * lead's question or a child's, then work running in it or its children. Its own lead stopping
 * is normal while children run, so that reads as the person's turn only once they're done.
 */
export function parentNow(own: NowState, children: ReadonlyArray<WorkRowStatus>) {
  const count = (status: WorkRowStatus) => children.filter((child) => child === status).length;
  const needYou = count("needs-input");
  const working = count("working");
  const headline: ParentHeadline =
    own.status === "needs-input" && own.asks
      ? "own-asks"
      : needYou > 0
        ? "children-need-you"
        : own.status === "working"
          ? "own-working"
          : working > 0
            ? "children-working"
            : own.status === "done" || own.status === "not-started"
              ? "settled"
              : "own-turn";
  return {
    headline,
    needYou,
    working,
    review: count("review"),
    done: count("done"),
    total: children.length,
  };
}
