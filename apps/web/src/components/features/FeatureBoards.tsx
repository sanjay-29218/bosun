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
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import { FeatureCard, TodoCard } from "./FeatureCard";

/** Done and Settled show their newest few until asked for more. */
const PAGE = 10;

const COLUMN_ICONS: Record<
  FeatureColumn,
  { readonly icon: LucideIcon; readonly className: string }
> = {
  todo: { icon: CircleIcon, className: "text-muted-foreground" },
  working: { icon: CircleDashedIcon, className: "text-info-foreground" },
  "needs-you": { icon: UserRoundIcon, className: "text-warning-foreground" },
  done: { icon: CircleCheckIcon, className: "text-success-foreground" },
};

const EMPTY_TEXT: Record<FeatureColumn, string> = {
  todo: "No todos",
  working: "Nothing running",
  "needs-you": "Nothing needs you",
  done: "Nothing finished yet",
};

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

function ColumnHeader(props: { readonly column: FeatureColumn; readonly count: number }) {
  const { icon: Icon, className } = COLUMN_ICONS[props.column];
  return (
    <header className="flex h-7 shrink-0 items-center gap-2 px-1.5 text-sm font-medium">
      <Icon aria-hidden className={cn("size-4 shrink-0", className)} />
      {FEATURE_COLUMN_LABELS[props.column]}
      <span className="font-normal text-muted-foreground tabular-nums">{props.count}</span>
    </header>
  );
}

/** A long stack shows its first page, then a button for the rest. */
function Paged<T>(props: {
  readonly items: ReadonlyArray<T>;
  readonly paged: boolean;
  readonly render: (item: T) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = props.paged && !expanded ? props.items.slice(0, PAGE) : props.items;
  const hidden = props.items.length - visible.length;
  return (
    <>
      {visible.map(props.render)}
      {hidden > 0 ? (
        <Button variant="ghost-muted" size="xs" onClick={() => setExpanded(true)}>
          Show {hidden} more
        </Button>
      ) : null}
    </>
  );
}

/** Settled features below Done, folded like the sidebar's Settled shelf. */
function SettledShelf(props: {
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly handlers: FeatureBoardHandlers;
  readonly drag: Drag | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const { drag, handlers } = props;
  if (props.cards.length === 0 && !drag) return null;
  return (
    <div {...drag?.dropProps("settled", "settled")} className="flex flex-col gap-1.5">
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        tone={drag?.over === "settled" ? "accent" : "muted"}
        accessory={<span className="font-normal tabular-nums">{props.cards.length}</span>}
      >
        Settled
      </CollapsibleSectionHeader>
      {expanded ? (
        <Paged
          items={props.cards}
          paged
          render={(card) => (
            <FeatureCard
              key={featureCardKey(card)}
              card={card}
              project={handlers.projectFor(card)}
              queuePosition={undefined}
              settled
              draggable={false}
              onOpen={handlers.onOpen}
              onMenu={handlers.onMenu}
              onAction={handlers.onAction}
              onShelf={handlers.canShelf(card) ? handlers.onShelf : null}
            />
          )}
        />
      ) : null}
    </div>
  );
}

function ColumnCards(props: {
  readonly group: FeatureColumnGroup;
  readonly todos: ReadonlyArray<EnvironmentIssue>;
  readonly handlers: FeatureBoardHandlers;
  readonly drag: Drag | null;
}) {
  const { group, handlers, drag } = props;
  return (
    <>
      <Paged
        items={group.cards}
        paged={group.column === "done"}
        render={(card) => (
          <FeatureCard
            key={featureCardKey(card)}
            card={card}
            project={handlers.projectFor(card)}
            queuePosition={handlers.queuePositions.get(featureCardKey(card))}
            settled={false}
            draggable={drag !== null}
            onOpen={handlers.onOpen}
            onMenu={handlers.onMenu}
            onAction={handlers.onAction}
            onShelf={handlers.canShelf(card) ? handlers.onShelf : null}
            {...(drag ? { onDragStart: drag.onDragStart } : {})}
          />
        )}
      />
      {/* The list pages Todo so a long backlog doesn't push Needs you off screen. */}
      <Paged
        items={props.todos}
        paged={drag === null}
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

/**
 * Todo, Working, Needs you and Done, as columns or as stacked sections. Todo holds open issues
 * and tickets beside features not started yet; settled features fold under Done.
 */
export function FeatureStatusBoard(props: {
  readonly layout: "board" | "list";
  readonly groups: ReadonlyArray<FeatureColumnGroup>;
  readonly todos: ReadonlyArray<EnvironmentIssue>;
  readonly settled: ReadonlyArray<EnvironmentFeatureCard>;
  readonly handlers: FeatureBoardHandlers;
}) {
  const drag = useCardDrag(props.handlers);
  const board = props.layout === "board";
  const count = (group: FeatureColumnGroup) =>
    group.cards.length + (group.column === "todo" ? props.todos.length : 0);
  if (!board) {
    return (
      <div className="flex flex-col gap-5">
        {props.groups.map((group) => (
          <section key={group.column} className="flex flex-col gap-1.5">
            <ColumnHeader column={group.column} count={count(group)} />
            {count(group) === 0 && group.column !== "done" ? (
              <p className="px-1.5 text-xs text-muted-foreground/70">{EMPTY_TEXT[group.column]}</p>
            ) : (
              <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-1.5">
                <ColumnCards
                  group={group}
                  todos={group.column === "todo" ? props.todos : []}
                  handlers={props.handlers}
                  drag={null}
                />
              </div>
            )}
            {group.column === "done" ? (
              <SettledShelf cards={props.settled} handlers={props.handlers} drag={null} />
            ) : null}
          </section>
        ))}
      </div>
    );
  }
  return (
    // Columns share the width, and scroll sideways only once they can't fit.
    <div
      className="grid min-h-0 flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col grid-rows-[minmax(0,1fr)] gap-2 overflow-x-auto pb-2"
      onDragEnd={drag.onDragEnd}
    >
      {props.groups.map((group) => {
        const isDone = group.column === "done";
        const total = count(group);
        return (
          <section
            key={group.column}
            {...drag.dropProps(group.column, isDone ? "done" : "open")}
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col gap-1.5 rounded-xl border border-transparent bg-muted/25 p-1.5",
              drag.over === group.column && "border-dashed border-border bg-accent/40",
            )}
          >
            <ColumnHeader column={group.column} count={total} />
            <ScrollArea className="min-h-0 flex-1">
              <div className="flex flex-col gap-1.5">
                {total === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground/70">
                    {EMPTY_TEXT[group.column]}
                  </p>
                ) : (
                  <ColumnCards
                    group={group}
                    todos={group.column === "todo" ? props.todos : []}
                    handlers={props.handlers}
                    drag={drag}
                  />
                )}
                {isDone ? (
                  <SettledShelf cards={props.settled} handlers={props.handlers} drag={drag} />
                ) : null}
              </div>
            </ScrollArea>
          </section>
        );
      })}
    </div>
  );
}
