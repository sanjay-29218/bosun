import type { FeatureColumn } from "@t3tools/client-runtime/state/crew-board";

/** A feature's column, and whether one of its threads is asking the person something. */
export interface NowState {
  readonly column: FeatureColumn;
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
export function parentNow(own: NowState, children: ReadonlyArray<FeatureColumn>) {
  const needYou = children.filter((column) => column === "needs-you").length;
  const working = children.filter((column) => column === "working").length;
  const done = children.filter((column) => column === "done").length;
  const headline: ParentHeadline =
    own.column === "needs-you" && own.asks
      ? "own-asks"
      : needYou > 0
        ? "children-need-you"
        : own.column === "working"
          ? "own-working"
          : working > 0
            ? "children-working"
            : own.column === "needs-you"
              ? "own-turn"
              : "settled";
  return { headline, needYou, working, done, total: children.length };
}
