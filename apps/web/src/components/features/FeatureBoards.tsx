import {
  FEATURE_COLUMN_LABELS,
  featureCardKey,
  featureDropAction,
  type EnvironmentFeatureCard,
  type FeatureCardActionId,
  type FeatureColumn,
  type FeatureColumnGroup,
} from "@t3tools/client-runtime/state/crew-board";
import { issueKey, type EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  ArchiveIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { FeatureCard, TodoCard } from "./FeatureCard";
import { FeatureRow, Paged, TodoRow, onRowListKeyDown } from "./FeatureRows";

const PAGE = 10;

/** The status columns, then features set aside: snoozed ones and settled ones. */
type BoardSection = FeatureColumn | "snoozed" | "settled";

const SECTION_META: Record<
  BoardSection,
  {
    readonly label: string;
    readonly icon: LucideIcon;
    readonly className: string;
    readonly empty: string;
  }
> = {
  todo: {
    label: FEATURE_COLUMN_LABELS.todo,
    icon: CircleIcon,
    className: "text-muted-foreground",
    empty: "No todos",
  },
  working: {
    label: FEATURE_COLUMN_LABELS.working,
    icon: CircleDashedIcon,
    className: "text-info-foreground",
    empty: "Nothing running",
  },
  "needs-you": {
    label: FEATURE_COLUMN_LABELS["needs-you"],
    icon: UserRoundIcon,
    className: "text-warning-foreground",
    empty: "Nothing needs you",
  },
  done: {
    label: FEATURE_COLUMN_LABELS.done,
    icon: CircleCheckIcon,
    className: "text-success-foreground",
    empty: "Nothing finished yet",
  },
  snoozed: {
    label: "Snoozed",
    icon: AlarmClockIcon,
    className: "text-muted-foreground",
    empty: "Nothing snoozed",
  },
  settled: {
    label: "Settled",
    icon: ArchiveIcon,
    className: "text-muted-foreground",
    empty: "Nothing settled",
  },
};

const BOARD_ORDER: ReadonlyArray<BoardSection> = [
  "todo",
  "working",
  "needs-you",
  "done",
  "snoozed",
  "settled",
];
/** The list puts what waits on you first. */
const LIST_ORDER: ReadonlyArray<BoardSection> = [
  "needs-you",
  "working",
  "todo",
  "done",
  "snoozed",
  "settled",
];
/** Sections that grow without bound show their newest few until asked for more. */
const PAGED = new Set<BoardSection>(["done", "snoozed", "settled"]);
/** Todo pages in the list so a long backlog doesn't bury what follows. */
const TODO_PAGE = 25;

interface SectionItems {
  readonly section: BoardSection;
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly todos: ReadonlyArray<EnvironmentIssue>;
}

type DropAction = "cancel" | "reopen" | "settle";
type DropTarget = "open" | "done" | "settled";

export interface FeatureBoardHandlers {
  readonly projectFor: (owner: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => EnvironmentProject | null;
  readonly queuePositions: ReadonlyMap<string, number>;
  readonly onOpen: (card: EnvironmentFeatureCard) => void;
  readonly onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) => void;
  readonly onAction: (
    card: EnvironmentFeatureCard,
    action: FeatureCardActionId,
    event: MouseEvent,
  ) => void;
  /** Settles a finished feature, or un-settles a settled one. */
  readonly onShelf: (card: EnvironmentFeatureCard) => void;
  /** Whether the feature has threads to settle. */
  readonly canShelf: (card: EnvironmentFeatureCard) => boolean;
  /** Wakes a snoozed feature's threads. */
  readonly onWake: (card: EnvironmentFeatureCard) => void;
  /** Called only for an allowed move: into Done stops, out of it reopens, onto Settled settles. */
  readonly onDrop: (
    card: EnvironmentFeatureCard,
    action: DropAction,
    position: { readonly x: number; readonly y: number },
  ) => void;
  readonly onOpenTodo: (issue: EnvironmentIssue) => void;
  readonly onStartTodo: (issue: EnvironmentIssue) => void;
}

const dropAction = (
  card: EnvironmentFeatureCard,
  target: DropTarget,
  handlers: FeatureBoardHandlers,
): DropAction | null => {
  if (target !== "settled") return featureDropAction(card, target);
  return handlers.canShelf(card) && (card.state === "done" || card.state === "cancelled")
    ? "settle"
    : null;
};

/** Drag state shared by the board's columns. Nothing moves until the server answers. */
function useCardDrag(handlers: FeatureBoardHandlers) {
  const dragged = useRef<EnvironmentFeatureCard | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const onDragStart = (card: EnvironmentFeatureCard, event: DragEvent) => {
    dragged.current = card;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", card.title);
  };
  const dropProps = (zone: string, target: DropTarget) => ({
    onDragOver: (event: DragEvent) => {
      const card = dragged.current;
      if (!card || dropAction(card, target, handlers) === null) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      if (over !== zone) setOver(zone);
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(null);
    },
    onDrop: (event: DragEvent) => {
      const card = dragged.current;
      const action = card ? dropAction(card, target, handlers) : null;
      if (!card || !action) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(null);
      dragged.current = null;
      handlers.onDrop(card, action, { x: event.clientX, y: event.clientY });
    },
  });
  return {
    onDragStart,
    onDragEnd: () => {
      dragged.current = null;
      setOver(null);
    },
    over,
    dropProps,
  };
}

type Drag = ReturnType<typeof useCardDrag>;

function SectionHeader(props: {
  readonly section: BoardSection;
  readonly count: number;
  readonly list: boolean;
}) {
  const { label, icon: Icon, className } = SECTION_META[props.section];
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-2 text-sm font-medium",
        props.list ? "h-9 border-b border-border/70 bg-muted/40 px-3" : "h-7 px-1.5",
      )}
    >
      <Icon aria-hidden className={cn("size-4 shrink-0", className)} />
      {label}
      <span className="font-normal text-muted-foreground tabular-nums">{props.count}</span>
    </header>
  );
}

function ColumnCards(props: {
  readonly items: SectionItems;
  readonly handlers: FeatureBoardHandlers;
  readonly drag: Drag;
}) {
  const { items, handlers, drag } = props;
  const shelved = items.section === "settled" || items.section === "snoozed";
  return (
    <>
      <Paged
        items={items.cards}
        pageSize={PAGED.has(items.section) ? PAGE : null}
        render={(card) => (
          <FeatureCard
            key={featureCardKey(card)}
            card={card}
            project={handlers.projectFor(card)}
            queuePosition={shelved ? undefined : handlers.queuePositions.get(featureCardKey(card))}
            settled={items.section === "settled"}
            draggable={!shelved}
            onOpen={handlers.onOpen}
            onMenu={handlers.onMenu}
            onAction={handlers.onAction}
            onShelf={handlers.canShelf(card) ? handlers.onShelf : null}
            onWake={items.section === "snoozed" ? handlers.onWake : null}
            onDragStart={drag.onDragStart}
          />
        )}
      />
      <Paged
        items={items.todos}
        pageSize={null}
        render={(issue) => (
          <TodoCard
            key={issueKey(issue)}
            issue={issue}
            project={handlers.projectFor(issue)}
            onOpen={handlers.onOpenTodo}
            onStart={handlers.onStartTodo}
          />
        )}
      />
    </>
  );
}

const dropTargetFor = (section: BoardSection): DropTarget | null =>
  section === "done"
    ? "done"
    : section === "settled"
      ? "settled"
      : section === "snoozed"
        ? null
        : "open";

/**
 * Todo, Working, Needs you and Done, then Snoozed and Settled, as columns or as stacked
 * sections. Todo holds open issues and tickets beside features not started yet.
 */
export function FeatureStatusBoard(props: {
  readonly layout: "board" | "list";
  readonly groups: ReadonlyArray<FeatureColumnGroup>;
  readonly todos: ReadonlyArray<EnvironmentIssue>;
  readonly snoozed: ReadonlyArray<EnvironmentFeatureCard>;
  readonly settled: ReadonlyArray<EnvironmentFeatureCard>;
  readonly handlers: FeatureBoardHandlers;
}) {
  const drag = useCardDrag(props.handlers);
  const itemsFor = (section: BoardSection): SectionItems => ({
    section,
    cards:
      section === "snoozed"
        ? props.snoozed
        : section === "settled"
          ? props.settled
          : (props.groups.find((group) => group.column === section)?.cards ?? []),
    todos: section === "todo" ? props.todos : [],
  });
  if (props.layout === "list") {
    return <FeatureStatusList sections={LIST_ORDER.map(itemsFor)} handlers={props.handlers} />;
  }
  return (
    // Columns share the width, and scroll sideways only once they can't fit.
    <div
      className="grid min-h-0 flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col grid-rows-[minmax(0,1fr)] gap-2 overflow-x-auto pb-2"
      onDragEnd={drag.onDragEnd}
    >
      {BOARD_ORDER.map(itemsFor).map((items) => {
        const total = items.cards.length + items.todos.length;
        const target = dropTargetFor(items.section);
        return (
          <section
            key={items.section}
            {...(target ? drag.dropProps(items.section, target) : {})}
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col gap-1.5 rounded-xl border border-transparent bg-muted/25 p-1.5",
              drag.over === items.section && "border-dashed border-border bg-accent/40",
            )}
          >
            <SectionHeader section={items.section} count={total} list={false} />
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-1.5">
                {total === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground/70">
                    {SECTION_META[items.section].empty}
                  </p>
                ) : (
                  <ColumnCards items={items} handlers={props.handlers} drag={drag} />
                )}
              </div>
            </ScrollArea>
          </section>
        );
      })}
    </div>
  );
}

function MoreRow(props: { readonly children: ReactNode }) {
  return (
    <div className="flex h-9 items-center border-b border-border/50 ps-24">{props.children}</div>
  );
}

/** One row per feature or todo, in full-width sections, like an issue tracker's list. */
function FeatureStatusList(props: {
  readonly sections: ReadonlyArray<SectionItems>;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { handlers } = props;
  const more = (button: ReactNode) => <MoreRow>{button}</MoreRow>;
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-border/70"
      onKeyDown={onRowListKeyDown}
    >
      {props.sections.map((items) => {
        const total = items.cards.length + items.todos.length;
        // Empty shelves add nothing to the list.
        if (total === 0 && (items.section === "snoozed" || items.section === "settled"))
          return null;
        const shelved = items.section === "settled" || items.section === "snoozed";
        return (
          <section key={items.section} className="flex flex-col">
            <SectionHeader section={items.section} count={total} list />
            {total === 0 && items.section !== "done" ? (
              <p className="border-b border-border/50 px-3 py-2 ps-24 text-xs text-muted-foreground/70">
                {SECTION_META[items.section].empty}
              </p>
            ) : null}
            <Paged
              items={items.cards}
              pageSize={PAGED.has(items.section) ? PAGE : null}
              more={more}
              render={(card) => (
                <FeatureRow
                  key={featureCardKey(card)}
                  card={card}
                  handlers={handlers}
                  queuePosition={
                    shelved ? undefined : handlers.queuePositions.get(featureCardKey(card))
                  }
                  settled={items.section === "settled"}
                  snoozed={items.section === "snoozed"}
                />
              )}
            />
            <Paged
              items={items.todos}
              pageSize={TODO_PAGE}
              more={more}
              render={(issue) => (
                <TodoRow key={issueKey(issue)} issue={issue} handlers={handlers} />
              )}
            />
          </section>
        );
      })}
    </div>
  );
}
