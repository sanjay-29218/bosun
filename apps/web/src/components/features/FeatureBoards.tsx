import {
  WORK_GROUPS,
  featureCardKey,
  type EnvironmentFeatureCard,
  type FeatureCardActionId,
  type WorkGroupCards,
  type WorkGroupId,
} from "@t3tools/client-runtime/state/crew-board";
import {
  issueKey,
  type EnvironmentIssue,
  type EnvironmentMilestone,
  type IssueGroups,
  type IssueTreeItem,
} from "@t3tools/client-runtime/state/issue-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { CircleIcon, MilestoneIcon, type LucideIcon } from "lucide-react";
import { Fragment, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";
import {
  BoardBand,
  ClosedPartsLine,
  GROUP_LOOK,
  IssueRow,
  MilestonePie,
  PagedRows,
  UnstartedFeatureRow,
  WorkChatRow,
  WorkFeatureRow,
  featureWork,
  onRowListKeyDown,
  type RowPlace,
} from "./BoardRows";
import { ChatCard, FeatureCard, FeatureParkControls, TodoCard } from "./FeatureCard";
import { FeatureChildList } from "./FeatureChildList";
import { FeatureNow } from "./FeatureNow";
import type { BoardWorkflow } from "./startFromBoard";

const PAGE = 10;
/** No milestone pages so a long backlog doesn't bury what follows. */
const ISSUE_PAGE = 25;

type Shelf = "snoozed" | "settled";
/** Work's groups, and the two shelves folded under them for work set aside. */
export type WorkSection = WorkGroupId | Shelf;

/**
 * Settled's open state and its older settled threads not loaded yet, counted as the sidebar
 * counts them. Opening it loads them.
 */
export interface SettledShelf {
  readonly expanded: boolean;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly unloaded: number;
}

/** Chat threads by the Work section they sit in. */
export type BoardChats = Partial<Record<WorkSection, ReadonlyArray<EnvironmentThreadShell>>>;

type DropAction = "settle";
type DropTarget = "open" | "done" | "settled";

export interface FeatureBoardHandlers {
  readonly projectFor: (owner: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => EnvironmentProject | null;
  /** The machine or project column of a row. */
  readonly placeFor: (owner: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => RowPlace;
  /** The feature's lead's and crew's threads, and a parent's open children's. */
  readonly threadsFor: (card: EnvironmentFeatureCard) => ReadonlyArray<EnvironmentThreadShell>;
  /** The child features the board shows under a parent. */
  readonly childrenFor: (card: EnvironmentFeatureCard) => ReadonlyArray<EnvironmentFeatureCard>;
  readonly onOpen: (card: EnvironmentFeatureCard) => void;
  readonly onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) => void;
  readonly onAction: (
    card: EnvironmentFeatureCard,
    action: FeatureCardActionId,
    event: MouseEvent,
  ) => void;
  /** Settles a feature, or un-settles a settled one. */
  readonly onShelf: (card: EnvironmentFeatureCard) => void;
  /** Whether the feature has threads to settle. */
  readonly canShelf: (card: EnvironmentFeatureCard) => boolean;
  readonly onWake: (card: EnvironmentFeatureCard) => void;
  readonly onSnooze: (card: EnvironmentFeatureCard, snoozedUntil: string) => void;
  /** Dragging onto Settled settles the feature; progress groups come from its PR and activity. */
  readonly onDrop: (
    card: EnvironmentFeatureCard,
    action: DropAction,
    position: { readonly x: number; readonly y: number },
  ) => void;
  /** Jumps from a feature's `#issue` to its row in Issues, and back. */
  readonly onShowIssue: (card: EnvironmentFeatureCard) => void;
  readonly onShowWork: (card: EnvironmentFeatureCard) => void;
  readonly onOpenTodo: (issue: EnvironmentIssue) => void;
  /** Starts a feature on a todo right here, on `workflow` or the project's last one. */
  readonly onStartTodo: (issue: EnvironmentIssue, workflow?: BoardWorkflow) => void;
  /** Opens the composer with the todo's brief, to edit before starting. */
  readonly onEditBrief: (issue: EnvironmentIssue) => void;
  readonly onCloseTodo: (issue: EnvironmentIssue) => void;
  readonly onOpenExternal: (url: string) => void;
  readonly workflowsFor: (owner: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => { readonly workflow: BoardWorkflow; readonly workflows: ReadonlyArray<BoardWorkflow> };
  /** The feature working on an issue. */
  readonly featureFor: (issue: EnvironmentIssue) => EnvironmentFeatureCard | null;
  readonly onOpenChat: (shell: EnvironmentThreadShell) => void;
  readonly onChatShelf: (shell: EnvironmentThreadShell) => void;
  readonly onChatWake: (shell: EnvironmentThreadShell) => void;
  readonly onChatSnooze: (shell: EnvironmentThreadShell, snoozedUntil: string) => void;
  /** New todo, filed in `milestone` when given. */
  readonly onNewTodo: (milestone?: EnvironmentMilestone) => void;
}

const dropAction = (
  card: EnvironmentFeatureCard,
  target: DropTarget,
  handlers: FeatureBoardHandlers,
): DropAction | null => {
  if (target !== "settled") return null;
  // Any feature settles, the way any thread does.
  return handlers.canShelf(card) ? "settle" : null;
};

/** Drag state shared by Work's columns. Nothing moves until the server answers. */
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

export interface WorkItems {
  readonly groups: ReadonlyArray<WorkGroupCards>;
  readonly snoozed: ReadonlyArray<EnvironmentFeatureCard>;
  readonly settled: ReadonlyArray<EnvironmentFeatureCard>;
  readonly chats: BoardChats;
}

const cardsIn = (items: WorkItems, section: WorkSection) =>
  section === "snoozed"
    ? items.snoozed
    : section === "settled"
      ? items.settled
      : (items.groups.find((group) => group.group === section)?.cards ?? []);

const isShelf = (section: WorkSection): section is Shelf =>
  section === "snoozed" || section === "settled";
const shelfOf = (section: WorkSection) => (isShelf(section) ? section : null);

/** A feature's row, with its child features nested under it. */
function WorkCardRows(props: {
  readonly card: EnvironmentFeatureCard;
  readonly section: WorkSection;
  readonly handlers: FeatureBoardHandlers;
}) {
  const children = props.handlers.childrenFor(props.card);
  return (
    <>
      <WorkFeatureRow card={props.card} handlers={props.handlers} shelf={shelfOf(props.section)} />
      {children.map((child, index) => (
        <WorkFeatureRow
          key={featureCardKey(child)}
          card={child}
          handlers={props.handlers}
          shelf={shelfOf(props.section)}
          nested={index === children.length - 1 ? "last" : "mid"}
        />
      ))}
    </>
  );
}

/** Work as a list: a band per group, then Snoozed and Settled folded at the bottom. */
export function WorkList(props: {
  readonly revealedRow?: string | null;
  readonly items: WorkItems;
  readonly settledShelf: SettledShelf;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { items, handlers } = props;
  const [snoozedOpen, setSnoozedOpen] = useState(false);
  const sections: ReadonlyArray<WorkSection> = [...WORK_GROUPS, "snoozed", "settled"];
  return (
    <div className="-mx-5 flex flex-col sm:-mx-6" onKeyDown={onRowListKeyDown}>
      {sections.map((section) => {
        const cards = cardsIn(items, section);
        const chats = items.chats[section] ?? [];
        const settled = section === "settled";
        const total = cards.length + chats.length + (settled ? props.settledShelf.unloaded : 0);
        if (total === 0) return null;
        const shelf = isShelf(section);
        const containsTarget = (card: EnvironmentFeatureCard): boolean =>
          featureCardKey(card) === props.revealedRow ||
          handlers.childrenFor(card).some(containsTarget);
        const revealIndex = cards.findIndex(containsTarget);
        const expanded =
          revealIndex >= 0 || !shelf || (settled ? props.settledShelf.expanded : snoozedOpen);
        const look = shelf ? null : GROUP_LOOK[section];
        return (
          <section key={section} className="flex flex-col">
            <BoardBand
              icon={look?.icon ?? CircleIcon}
              iconClassName={look?.className ?? "text-muted-foreground"}
              label={look?.label ?? (section === "snoozed" ? "Snoozed" : "Settled")}
              count={total}
              right={section === "done" ? "Merged" : null}
              {...(shelf
                ? {
                    expanded,
                    onToggle: () =>
                      settled
                        ? props.settledShelf.onExpandedChange(!expanded)
                        : setSnoozedOpen(!expanded),
                  }
                : {})}
            />
            {expanded ? (
              <>
                <PagedRows
                  items={cards}
                  revealIndex={revealIndex}
                  pageSize={section === "done" || shelf ? PAGE : null}
                  render={(card) => (
                    <WorkCardRows
                      key={featureCardKey(card)}
                      card={card}
                      section={section}
                      handlers={handlers}
                    />
                  )}
                />
                <PagedRows
                  items={chats}
                  pageSize={section === "done" || shelf ? PAGE : null}
                  render={(shell) => (
                    <WorkChatRow
                      key={`${shell.environmentId}:${shell.id}`}
                      shell={shell}
                      handlers={handlers}
                      shelf={shelfOf(section)}
                    />
                  )}
                />
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function ColumnHeader(props: {
  readonly icon: LucideIcon;
  readonly className: string;
  readonly label: ReactNode;
  readonly count: number | null;
  readonly right?: ReactNode;
}) {
  return (
    <header className="flex h-7 shrink-0 items-center gap-2 px-1.5 text-sm font-medium">
      <props.icon aria-hidden className={cn("size-4 shrink-0", props.className)} />
      <span className="min-w-0 truncate">{props.label}</span>
      {props.count === null ? null : (
        <span className="font-normal text-muted-foreground tabular-nums">{props.count}</span>
      )}
      {props.right ? (
        <span className="ms-auto flex shrink-0 items-center gap-1.5 text-xs font-normal text-muted-foreground">
          {props.right}
        </span>
      ) : null}
    </header>
  );
}

function Columns(props: { readonly children: ReactNode; readonly onDragEnd?: () => void }) {
  return (
    // Columns share the width, and scroll sideways only once they can't fit.
    <div
      className="grid min-h-0 flex-1 auto-cols-[minmax(15rem,1fr)] grid-flow-col grid-rows-[minmax(0,1fr)] gap-2 overflow-x-auto overscroll-x-contain pb-2"
      onDragEnd={props.onDragEnd}
    >
      {props.children}
    </div>
  );
}

function Column(props: {
  readonly header: ReactNode;
  readonly empty: string | null;
  readonly children: ReactNode;
  readonly className?: string;
  readonly dropProps?: object;
}) {
  return (
    <section
      {...props.dropProps}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-col gap-1.5 rounded-xl border border-transparent bg-muted/25 p-1.5",
        props.className,
      )}
    >
      {props.header}
      <ScrollArea className="min-h-0 flex-1" chainHorizontalScroll>
        <div className="flex flex-col gap-1.5">
          {props.empty ? (
            <p className="py-6 text-center text-xs text-muted-foreground/70">{props.empty}</p>
          ) : (
            props.children
          )}
        </div>
      </ScrollArea>
    </section>
  );
}

function WorkCards(props: {
  readonly cards: ReadonlyArray<EnvironmentFeatureCard>;
  readonly chats: ReadonlyArray<EnvironmentThreadShell>;
  readonly section: WorkSection;
  readonly handlers: FeatureBoardHandlers;
  readonly drag: Drag;
}) {
  const { handlers } = props;
  const shelf = shelfOf(props.section);
  return (
    <>
      <PagedRows
        items={props.cards}
        pageSize={props.section === "done" || shelf ? PAGE : null}
        render={(card) => (
          <FeatureCard
            key={featureCardKey(card)}
            card={card}
            project={handlers.projectFor(card)}
            work={featureWork(card, handlers)}
            settled={shelf !== null}
            draggable={shelf === null}
            onOpen={handlers.onOpen}
            onMenu={handlers.onMenu}
            onAction={handlers.onAction}
            parkControls={<FeatureParkControls card={card} shelf={shelf} handlers={handlers} />}
            subfeatures={
              <FeatureChildList cards={handlers.childrenFor(card)} handlers={handlers} />
            }
            now={
              <FeatureNow
                card={card}
                threadsFor={handlers.threadsFor}
                childCards={handlers.childrenFor(card)}
              />
            }
            onDragStart={props.drag.onDragStart}
          />
        )}
      />
      <PagedRows
        items={props.chats}
        pageSize={props.section === "done" || shelf ? PAGE : null}
        render={(shell) => (
          <ChatCard
            key={`${shell.environmentId}:${shell.id}`}
            shell={shell}
            project={handlers.projectFor(shell)}
            shelf={shelf}
            handlers={handlers}
          />
        )}
      />
    </>
  );
}

/** Snoozed or Settled, folded under Done like the sidebar's Settled shelf. */
function BoardShelf(props: {
  readonly section: Shelf;
  readonly items: WorkItems;
  readonly handlers: FeatureBoardHandlers;
  readonly drag: Drag;
  /** Given for Settled, whose older threads load only while it is open. */
  readonly open?: SettledShelf;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = props.open?.expanded ?? localExpanded;
  const setExpanded = props.open?.onExpandedChange ?? setLocalExpanded;
  const cards = cardsIn(props.items, props.section);
  const chats = props.items.chats[props.section] ?? [];
  // Settled stays as a drop target even when empty; an empty Snoozed shows nothing.
  const dropTarget = props.section === "settled";
  const count = cards.length + chats.length + (props.open?.unloaded ?? 0);
  if (count === 0 && !dropTarget) return null;
  return (
    <div
      {...(dropTarget ? props.drag.dropProps("settled", "settled") : {})}
      className="flex flex-col gap-1.5"
    >
      <CollapsibleSectionHeader
        expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        tone={props.drag.over === props.section ? "accent" : "muted"}
        accessory={<span className="font-normal tabular-nums">{count}</span>}
      >
        {props.section === "snoozed" ? "Snoozed" : "Settled"}
      </CollapsibleSectionHeader>
      {expanded ? (
        <WorkCards
          cards={cards}
          chats={chats}
          section={props.section}
          handlers={props.handlers}
          drag={props.drag}
        />
      ) : null}
    </div>
  );
}

/** Work as columns, one per group, with Snoozed and Settled folded under Done. */
export function WorkColumns(props: {
  readonly items: WorkItems;
  readonly settledShelf: SettledShelf;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { items, handlers } = props;
  const drag = useCardDrag(handlers);
  return (
    <Columns onDragEnd={drag.onDragEnd}>
      {WORK_GROUPS.map((group) => {
        const cards = cardsIn(items, group);
        const chats = items.chats[group] ?? [];
        const look = GROUP_LOOK[group];
        const isDone = group === "done";
        return (
          <Column
            key={group}
            dropProps={drag.dropProps(group, isDone ? "done" : "open")}
            className={cn(drag.over === group && "border-dashed border-border bg-accent/40")}
            header={
              <ColumnHeader
                icon={look.icon}
                className={look.className}
                label={look.label}
                count={cards.length + chats.length}
              />
            }
            empty={null}
          >
            <WorkCards
              cards={cards}
              chats={chats}
              section={group}
              handlers={handlers}
              drag={drag}
            />
            {isDone ? (
              <>
                <BoardShelf section="snoozed" items={items} handlers={handlers} drag={drag} />
                <BoardShelf
                  section="settled"
                  items={items}
                  handlers={handlers}
                  drag={drag}
                  open={props.settledShelf}
                />
              </>
            ) : null}
          </Column>
        );
      })}
    </Columns>
  );
}

/** How far a milestone has come: closed issues, and open ones whose work waits for review. */
function milestoneProgress(
  milestone: EnvironmentMilestone,
  items: ReadonlyArray<IssueTreeItem>,
  handlers: FeatureBoardHandlers,
) {
  const review = items
    .flatMap((item) => [item.issue, ...item.parts])
    .filter((issue) => {
      const feature = handlers.featureFor(issue);
      return (
        feature !== null &&
        feature.leadThreadId !== null &&
        featureWork(feature, handlers).group === "review"
      );
    }).length;
  const total = milestone.openIssues + milestone.closedIssues;
  return { done: milestone.closedIssues, review, total };
}

function MilestoneProgress(props: {
  readonly milestone: EnvironmentMilestone;
  readonly items: ReadonlyArray<IssueTreeItem>;
  readonly handlers: FeatureBoardHandlers;
}) {
  const progress = milestoneProgress(props.milestone, props.items, props.handlers);
  return (
    <>
      <MilestonePie {...progress} />
      <span className="tabular-nums max-sm:hidden">
        {progress.done} of {progress.total} done
        {progress.review > 0 ? ` · ${progress.review} in review` : ""}
      </span>
    </>
  );
}

const itemCount = (items: ReadonlyArray<IssueTreeItem>) =>
  items.reduce((count, item) => count + 1 + item.parts.length, 0);

/** An open issue with its open sub-issues under it, then its closed ones folded into one line. */
function IssueItemRows(props: {
  readonly item: IssueTreeItem;
  readonly handlers: FeatureBoardHandlers;
  readonly starting: ReadonlySet<string>;
}) {
  const { item, handlers } = props;
  const closed = item.closedParts > 0 && item.parts.length > 0;
  return (
    <>
      <IssueRow
        item={item}
        handlers={handlers}
        starting={props.starting.has(issueKey(item.issue))}
      />
      {item.parts.map((part, index) => (
        <IssueRow
          key={issueKey(part)}
          item={{ issue: part, parts: [], closedParts: 0 }}
          handlers={handlers}
          starting={props.starting.has(issueKey(part))}
          nested={index === item.parts.length - 1 && !closed ? "last" : "mid"}
        />
      ))}
      {closed ? <ClosedPartsLine count={item.closedParts} /> : null}
    </>
  );
}

export interface IssueItems {
  readonly groups: IssueGroups;
  /** Features not started that have no issue of their own; they sit with the backlog. */
  readonly unstarted: ReadonlyArray<EnvironmentFeatureCard>;
  readonly pending: boolean;
  readonly starting: ReadonlySet<string>;
}

/** Issues as a list: each open milestone, then No milestone, then closed milestones folded. */
export function IssuesList(props: {
  readonly revealedRow?: string | null;
  readonly items: IssueItems;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { handlers } = props;
  const { groups, starting } = props.items;
  const [closedOpen, setClosedOpen] = useState(false);
  const revealClosed = groups.closedMilestones.some((group) =>
    group.items.some((item) =>
      [item.issue, ...item.parts].some((issue) => issueKey(issue) === props.revealedRow),
    ),
  );
  const rows = (items: ReadonlyArray<IssueTreeItem>, pageSize: number | null) => (
    <PagedRows
      items={items}
      revealIndex={items.findIndex((item) =>
        [item.issue, ...item.parts].some((issue) => issueKey(issue) === props.revealedRow),
      )}
      pageSize={pageSize}
      render={(item) => (
        <IssueItemRows
          key={issueKey(item.issue)}
          item={item}
          handlers={handlers}
          starting={starting}
        />
      )}
    />
  );
  const closedCount = groups.closedMilestones.reduce(
    (count, group) => count + itemCount(group.items),
    0,
  );
  if (props.items.pending) {
    return (
      <div className="flex flex-col gap-2 py-2">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-6 w-1/2" />
        ))}
      </div>
    );
  }
  return (
    <div className="-mx-5 flex flex-col sm:-mx-6" onKeyDown={onRowListKeyDown}>
      {groups.milestones.map((group) => (
        <section key={issueKey(group.milestone)} className="flex flex-col">
          <BoardBand
            icon={MilestoneIcon}
            iconClassName="text-muted-foreground"
            label={group.milestone.title}
            count={itemCount(group.items)}
            right={
              <MilestoneProgress
                milestone={group.milestone}
                items={group.items}
                handlers={handlers}
              />
            }
            onAdd={() => handlers.onNewTodo(group.milestone)}
          />
          {rows(group.items, null)}
        </section>
      ))}
      {groups.none.length + props.items.unstarted.length > 0 ? (
        <section className="flex flex-col">
          <BoardBand
            icon={CircleIcon}
            iconClassName="text-muted-foreground/70"
            label="No milestone"
            count={itemCount(groups.none) + props.items.unstarted.length}
            onAdd={() => handlers.onNewTodo()}
          />
          {props.items.unstarted.map((card) => (
            <UnstartedFeatureRow key={featureCardKey(card)} card={card} handlers={handlers} />
          ))}
          {rows(groups.none, ISSUE_PAGE)}
        </section>
      ) : null}
      {closedCount > 0 ? (
        <section className="flex flex-col">
          <BoardBand
            icon={MilestoneIcon}
            iconClassName="text-muted-foreground"
            label="Closed milestones"
            count={closedCount}
            expanded={closedOpen || revealClosed}
            onToggle={() => setClosedOpen(!closedOpen)}
          />
          {closedOpen || revealClosed
            ? groups.closedMilestones.map((group) => (
                <Fragment key={group.key}>
                  <div className="flex h-8 items-center gap-2 ps-18 text-xs text-muted-foreground">
                    <MilestoneIcon aria-hidden className="size-3.5" />
                    {group.title}
                  </div>
                  {rows(group.items, null)}
                </Fragment>
              ))
            : null}
        </section>
      ) : null}
    </div>
  );
}

function IssueCards(props: {
  readonly items: ReadonlyArray<IssueTreeItem>;
  readonly handlers: FeatureBoardHandlers;
  readonly starting: ReadonlySet<string>;
}) {
  const { handlers } = props;
  return (
    <PagedRows
      items={props.items.flatMap((item) => [item.issue, ...item.parts])}
      pageSize={ISSUE_PAGE}
      render={(issue) => (
        <TodoCard
          key={issueKey(issue)}
          issue={issue}
          project={handlers.projectFor(issue)}
          handlers={handlers}
          starting={props.starting.has(issueKey(issue))}
        />
      )}
    />
  );
}

/** Issues as columns: one per open milestone, then No milestone. */
export function IssuesColumns(props: {
  readonly items: IssueItems;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { handlers } = props;
  const { groups, starting } = props.items;
  return (
    <Columns>
      {groups.milestones.map((group) => (
        <Column
          key={issueKey(group.milestone)}
          header={
            <ColumnHeader
              icon={MilestoneIcon}
              className="text-muted-foreground"
              label={group.milestone.title}
              count={itemCount(group.items)}
              right={
                <MilestonePie {...milestoneProgress(group.milestone, group.items, handlers)} />
              }
            />
          }
          empty={null}
        >
          <IssueCards items={group.items} handlers={handlers} starting={starting} />
        </Column>
      ))}
      <Column
        header={
          <ColumnHeader
            icon={CircleIcon}
            className="text-muted-foreground/70"
            label="No milestone"
            count={props.items.pending ? null : itemCount(groups.none)}
          />
        }
        empty={!props.items.pending && groups.none.length === 0 ? "Nothing here" : null}
      >
        {props.items.pending ? (
          [0, 1, 2].map((index) => <Skeleton key={index} shape="card" className="h-24" />)
        ) : (
          <IssueCards items={groups.none} handlers={handlers} starting={starting} />
        )}
      </Column>
    </Columns>
  );
}
