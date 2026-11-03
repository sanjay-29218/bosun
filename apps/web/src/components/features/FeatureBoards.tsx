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
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
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
import { ChevronRightIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import { ChatCard, FeatureCard, FeatureParkControls, TodoCard } from "./FeatureCard";
import { ChatRow, FeatureRow, Paged, TodoRow, onRowListKeyDown } from "./FeatureRows";

const PAGE = 10;

/** The status columns, and the two shelves under Done for features set aside. */
type Shelf = "snoozed" | "settled";
export type BoardSection = FeatureColumn | Shelf;
/**
 * Settled's open state and its older settled threads not loaded yet, counted as the sidebar
 * counts them. Opening it loads them.
 */
export interface SettledShelf {
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly unloaded: number;
}

/** Chat threads by the section they sit in; chats are never in Todo. */
export type BoardChats = Partial<Record<BoardSection, ReadonlyArray<EnvironmentThreadShell>>>;

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

const BOARD_ORDER: ReadonlyArray<FeatureColumn> = ["todo", "working", "needs-you", "done"];
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
const isShelf = (section: BoardSection): section is Shelf =>
  section === "snoozed" || section === "settled";
/** Todo pages in the list so a long backlog doesn't bury what follows. */
const TODO_PAGE = 25;

interface SectionItems {
  readonly section: BoardSection;
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly chats: ReadonlyArray<EnvironmentThreadShell>;
  readonly todos: ReadonlyArray<EnvironmentIssue>;
  /** Some project's issues haven't arrived yet; Todo waits for all of them at once. */
  readonly todosPending: boolean;
}

/** Stand-ins for todos still loading, so slow projects don't trickle into the sorted list. */
const PENDING_TODOS = [0, 1, 2];

type DropAction = "close" | "reopen" | "settle";
type DropTarget = "open" | "done" | "settled";

export interface FeatureBoardHandlers {
  readonly projectFor: (owner: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => EnvironmentProject | null;
  /** The feature's lead's and crew's threads. */
  readonly threadsFor: (card: EnvironmentFeatureCard) => ReadonlyArray<EnvironmentThreadShell>;
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
  /** Snoozes a feature's threads until `snoozedUntil`. */
  readonly onSnooze: (card: EnvironmentFeatureCard, snoozedUntil: string) => void;
  /** Called only for an allowed move: into Done closes, out of it reopens, onto Settled settles. */
  readonly onDrop: (
    card: EnvironmentFeatureCard,
    action: DropAction,
    position: { readonly x: number; readonly y: number },
  ) => void;
  readonly onOpenTodo: (issue: EnvironmentIssue) => void;
  readonly onStartTodo: (issue: EnvironmentIssue) => void;
  readonly onOpenChat: (shell: EnvironmentThreadShell) => void;
  readonly onChatShelf: (shell: EnvironmentThreadShell) => void;
  readonly onChatWake: (shell: EnvironmentThreadShell) => void;
  readonly onChatSnooze: (shell: EnvironmentThreadShell, snoozedUntil: string) => void;
}

const dropAction = (
  card: EnvironmentFeatureCard,
  target: DropTarget,
  handlers: FeatureBoardHandlers,
): DropAction | null => {
  if (target !== "settled") return featureDropAction(card, target);
  // Any feature settles, the way any thread does.
  return handlers.canShelf(card) ? "settle" : null;
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
  /** Null while the count isn't known yet. */
  readonly count: number | null;
  readonly list: boolean;
  /** Given for a list shelf, which folds. */
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
}) {
  const { label, icon: Icon, className } = SECTION_META[props.section];
  const content = (
    <>
      <Icon aria-hidden className={cn("size-4 shrink-0", className)} />
      {label}
      {props.count === null ? null : (
        <span className="font-normal text-muted-foreground tabular-nums">{props.count}</span>
      )}
    </>
  );
  const headerClassName = cn(
    "flex shrink-0 items-center gap-2 text-sm font-medium",
    props.list ? "h-9 border-b border-border/70 bg-muted/40 px-3" : "h-7 px-1.5",
  );
  if (props.onToggle) {
    return (
      <header className={headerClassName}>
        <button
          type="button"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
          className="flex flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
        >
          {content}
          <ChevronRightIcon
            aria-hidden
            className={cn("ms-auto size-4 text-muted-foreground", props.expanded && "rotate-90")}
          />
        </button>
      </header>
    );
  }
  return <header className={headerClassName}>{content}</header>;
}

function ColumnCards(props: {
  readonly items: SectionItems;
  readonly handlers: FeatureBoardHandlers;
  readonly drag: Drag;
}) {
  const { items, handlers, drag } = props;
  const shelved = isShelf(items.section);
  return (
    <>
      <Paged
        items={items.cards}
        pageSize={PAGED.has(items.section) ? PAGE : null}
        render={(card) => (
          <FeatureCard
            key={featureCardKey(card)}
            card={card}
            threads={handlers.threadsFor(card)}
            project={handlers.projectFor(card)}
            settled={shelved}
            draggable={!shelved}
            onOpen={handlers.onOpen}
            onMenu={handlers.onMenu}
            onAction={handlers.onAction}
            parkControls={
              <FeatureParkControls
                card={card}
                shelf={isShelf(items.section) ? items.section : null}
                handlers={handlers}
              />
            }
            onDragStart={drag.onDragStart}
          />
        )}
      />
      <Paged
        items={items.chats}
        pageSize={PAGED.has(items.section) ? PAGE : null}
        render={(shell) => (
          <ChatCard
            key={`${shell.environmentId}:${shell.id}`}
            shell={shell}
            project={handlers.projectFor(shell)}
            shelf={isShelf(items.section) ? items.section : null}
            handlers={handlers}
          />
        )}
      />
      {items.todosPending ? (
        PENDING_TODOS.map((index) => <Skeleton key={index} shape="card" className="h-24" />)
      ) : (
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
      )}
    </>
  );
}

/** Snoozed or Settled, folded under Done like the sidebar's Settled shelf. */
function BoardShelf(props: {
  readonly items: SectionItems;
  readonly handlers: FeatureBoardHandlers;
  readonly drag: Drag;
  /** Given for Settled, whose older threads load only while it is open. */
  readonly open?: SettledShelf;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = props.open?.expanded ?? localExpanded;
  const setExpanded = props.open?.onExpandedChange ?? setLocalExpanded;
  const { items, drag } = props;
  // Settled stays as a drop target even when empty; an empty Snoozed shows nothing.
  const dropTarget = items.section === "settled";
  const count = items.cards.length + items.chats.length + (props.open?.unloaded ?? 0);
  if (count === 0 && !dropTarget) return null;
  return (
    <div
      {...(dropTarget ? drag.dropProps("settled", "settled") : {})}
      className="flex flex-col gap-1.5"
    >
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        tone={drag.over === items.section ? "accent" : "muted"}
        accessory={<span className="font-normal tabular-nums">{count}</span>}
      >
        {SECTION_META[items.section].label}
      </CollapsibleSectionHeader>
      {expanded ? <ColumnCards items={items} handlers={props.handlers} drag={drag} /> : null}
    </div>
  );
}

/**
 * Todo, Working, Needs you and Done, as columns or as stacked sections, with Snoozed and
 * Settled folded under Done. Todo holds open issues and tickets beside features not started yet;
 * chat threads sit in the other columns beside features.
 */
export function FeatureStatusBoard(props: {
  readonly layout: "board" | "list";
  readonly groups: ReadonlyArray<FeatureColumnGroup>;
  readonly todos: ReadonlyArray<EnvironmentIssue>;
  readonly todosPending: boolean;
  readonly snoozed: ReadonlyArray<EnvironmentFeatureCard>;
  readonly settled: ReadonlyArray<EnvironmentFeatureCard>;
  readonly chats: BoardChats;
  readonly settledShelf: SettledShelf;
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
    chats: props.chats[section] ?? [],
    todos: section === "todo" && !props.todosPending ? props.todos : [],
    todosPending: section === "todo" && props.todosPending,
  });
  if (props.layout === "list") {
    return (
      <FeatureStatusList
        sections={LIST_ORDER.map(itemsFor)}
        settledShelf={props.settledShelf}
        handlers={props.handlers}
      />
    );
  }
  return (
    // Columns share the width, and scroll sideways only once they can't fit.
    <div
      className="grid min-h-0 flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col grid-rows-[minmax(0,1fr)] gap-2 overflow-x-auto overscroll-x-contain pb-2"
      onDragEnd={drag.onDragEnd}
    >
      {BOARD_ORDER.map(itemsFor).map((items) => {
        const isDone = items.section === "done";
        const total = items.cards.length + items.chats.length + items.todos.length;
        return (
          <section
            key={items.section}
            {...drag.dropProps(items.section, isDone ? "done" : "open")}
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col gap-1.5 rounded-xl border border-transparent bg-muted/25 p-1.5",
              drag.over === items.section && "border-dashed border-border bg-accent/40",
            )}
          >
            <SectionHeader
              section={items.section}
              count={items.todosPending ? null : total}
              list={false}
            />
            <ScrollArea className="min-h-0 flex-1" chainHorizontalScroll>
              <div className="flex flex-col gap-1.5">
                {total === 0 && !items.todosPending ? (
                  <p className="py-6 text-center text-xs text-muted-foreground/70">
                    {SECTION_META[items.section].empty}
                  </p>
                ) : (
                  <ColumnCards items={items} handlers={props.handlers} drag={drag} />
                )}
                {isDone ? (
                  <>
                    <BoardShelf items={itemsFor("snoozed")} handlers={props.handlers} drag={drag} />
                    <BoardShelf
                      items={itemsFor("settled")}
                      handlers={props.handlers}
                      drag={drag}
                      open={props.settledShelf}
                    />
                  </>
                ) : null}
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
  readonly settledShelf: SettledShelf;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { handlers } = props;
  const [openShelves, setOpenShelves] = useState<ReadonlySet<BoardSection>>(new Set());
  const more = (button: ReactNode) => <MoreRow>{button}</MoreRow>;
  return (
    <div
      className="flex flex-col overflow-hidden rounded-lg border border-border/70"
      onKeyDown={onRowListKeyDown}
    >
      {props.sections.map((items) => {
        const settled = items.section === "settled";
        const total =
          items.cards.length +
          items.chats.length +
          items.todos.length +
          (settled ? props.settledShelf.unloaded : 0);
        const shelved = isShelf(items.section);
        // Empty shelves add nothing to the list; full ones stay folded until opened.
        if (shelved && total === 0) return null;
        const folded =
          shelved && !(settled ? props.settledShelf.expanded : openShelves.has(items.section));
        return (
          <section key={items.section} className="flex flex-col">
            <SectionHeader
              section={items.section}
              count={items.todosPending ? null : total}
              list
              {...(shelved
                ? {
                    expanded: !folded,
                    onToggle: () =>
                      settled
                        ? props.settledShelf.onExpandedChange(folded)
                        : setOpenShelves((current) => {
                            const next = new Set(current);
                            if (!next.delete(items.section)) next.add(items.section);
                            return next;
                          }),
                  }
                : {})}
            />
            {folded ? null : (
              <>
                {total === 0 && items.section !== "done" && !items.todosPending ? (
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
                      shelf={isShelf(items.section) ? items.section : null}
                    />
                  )}
                />
                <Paged
                  items={items.chats}
                  pageSize={PAGED.has(items.section) ? PAGE : null}
                  more={more}
                  render={(shell) => (
                    <ChatRow
                      key={`${shell.environmentId}:${shell.id}`}
                      shell={shell}
                      handlers={handlers}
                      shelf={isShelf(items.section) ? items.section : null}
                    />
                  )}
                />
                {items.todosPending
                  ? PENDING_TODOS.map((index) => (
                      <div
                        key={index}
                        className="flex h-9 items-center border-b border-border/50 px-3"
                      >
                        <Skeleton className="h-3 w-1/2" />
                      </div>
                    ))
                  : null}
                <Paged
                  items={items.todos}
                  pageSize={TODO_PAGE}
                  more={more}
                  render={(issue) => (
                    <TodoRow key={issueKey(issue)} issue={issue} handlers={handlers} />
                  )}
                />
              </>
            )}
          </section>
        );
      })}
    </div>
  );
}
