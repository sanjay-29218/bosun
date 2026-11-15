import {
  featureCardKey,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import {
  groupIssueParts,
  issueKey,
  issuePlace,
  type EnvironmentIssue,
  type IssuePlace,
} from "@t3tools/client-runtime/state/issue-board";

import type { BoardSection, FeatureBoardHandlers } from "./FeatureBoards";

/** Where a feature's issue sits: its parent's number and its sub-issues' progress. */
export interface IssueStructureFacts {
  readonly url: string;
  readonly parent: number | null;
  readonly parentTitle: string | null;
  readonly subIssues: { readonly completed: number; readonly total: number } | null;
}

/**
 * A feature's issue as the board last read it, falling back to what the feature recorded when
 * it linked the issue. Tickets and tracker keys have no structure.
 */
export function featureIssueStructure(
  card: EnvironmentFeatureCard,
  handlers: Pick<FeatureBoardHandlers, "issueAt">,
): IssueStructureFacts | null {
  const issue = card.issue;
  if (!issue || issue.ticketId !== undefined || issue.key !== undefined || !issue.url) return null;
  const loaded = handlers.issueAt(card.environmentId, issue.url);
  const parent = loaded ? loaded.parent : (issue.parent ?? null);
  return {
    url: issue.url,
    parent,
    parentTitle:
      parent === null
        ? null
        : (handlers.issueAt(card.environmentId, issue.url, parent)?.title ?? null),
    subIssues: loaded ? loaded.subIssues : issue.subIssues,
  };
}

/** The cards and todos of one board section, in its order. */
interface SectionPool {
  readonly section: BoardSection;
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly todos: ReadonlyArray<EnvironmentIssue>;
}

export type ListItem =
  | { readonly kind: "card"; readonly card: EnvironmentFeatureCard; readonly section: BoardSection }
  | { readonly kind: "todo"; readonly issue: EnvironmentIssue; readonly section: BoardSection };

export const listItemKey = (item: ListItem) =>
  item.kind === "card" ? featureCardKey(item.card) : issueKey(item.issue);

/**
 * Parents with their loaded parts nested under them. Narrowed to a milestone, each parent with
 * parts in view leads the list with all of them, whatever their status; otherwise a part nests
 * only under a parent in its own section, so every section stays true to its status.
 */
export function nestListParts(
  sections: ReadonlyArray<SectionPool>,
  handlers: Pick<FeatureBoardHandlers, "issueAt" | "childrenFor">,
  liftParents: boolean,
) {
  const places = new Map<ListItem, IssuePlace | null>();
  const placeOf = (item: ListItem) => {
    if (!places.has(item)) {
      const facts =
        item.kind === "card"
          ? featureIssueStructure(item.card, handlers)
          : item.issue.ticketId
            ? null
            : item.issue;
      const environmentId =
        item.kind === "card" ? item.card.environmentId : item.issue.environmentId;
      places.set(item, facts ? issuePlace(environmentId, facts) : null);
    }
    return places.get(item) ?? null;
  };
  const pools = sections.map((items): ReadonlyArray<ListItem> => [
    ...items.cards.map((card) => ({ kind: "card" as const, card, section: items.section })),
    ...items.todos.map((issue) => ({ kind: "todo" as const, issue, section: items.section })),
  ]);
  const parts = new Map<string, ReadonlyArray<ListItem>>();
  /** A head's child features that aren't also its issue's parts; those fold with the parts. */
  const headChildren = new Map<string, ReadonlyArray<EnvironmentFeatureCard>>();
  /** Items shown elsewhere than their section's own list. */
  const moved = new Set<string>();
  const lifted: ListItem[] = [];
  for (const pool of liftParents ? [pools.flat()] : pools) {
    const grouped = groupIssueParts(pool, placeOf);
    for (const item of pool) {
      const place = placeOf(item);
      if (!place) continue;
      const nested = grouped.nested.has(place.key);
      if (nested) moved.add(listItemKey(item));
      // A child feature on one of the head's sub-issues is one of its parts, shown once.
      const childParts: ListItem[] = [];
      if (item.kind === "card" && !nested) {
        const others: EnvironmentFeatureCard[] = [];
        for (const card of handlers.childrenFor(item.card)) {
          const child = { kind: "card" as const, card, section: item.section };
          if (placeOf(child)?.parentKey === place.key) childParts.push(child);
          else others.push(card);
        }
        if (childParts.length > 0) headChildren.set(listItemKey(item), others);
      }
      const itemParts = [...childParts, ...(grouped.parts.get(place.key) ?? [])];
      if (itemParts.length === 0) continue;
      parts.set(listItemKey(item), itemParts);
      if (liftParents && !nested) {
        lifted.push(item);
        moved.add(listItemKey(item));
      }
    }
  }
  return {
    lifted,
    partsFor: (item: ListItem) => parts.get(listItemKey(item)) ?? [],
    /** The child features shown under a card's own row, always visible. */
    childrenFor: (card: EnvironmentFeatureCard) =>
      headChildren.get(featureCardKey(card)) ?? handlers.childrenFor(card),
    shows: (item: ListItem) => !moved.has(listItemKey(item)),
  };
}
