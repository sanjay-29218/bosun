import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  WORK_GROUP_LABELS,
  chatWorkGroup,
  featureCardKey,
  featureProgress,
  featurePullRequest,
  featureRef,
  featureWorkGroup,
  threadPullRequest,
  type EnvironmentFeatureCard,
  type FeatureStatus,
  type WorkGroupId,
  type WorkPullRequest,
} from "@t3tools/client-runtime/state/crew-board";
import {
  issueKey,
  issueRef,
  type EnvironmentIssue,
  type IssueTreeItem,
} from "@t3tools/client-runtime/state/issue-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  ArrowUpRightIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  CircleIcon,
  CirclePauseIcon,
  EllipsisIcon,
  EyeIcon,
  ListTreeIcon,
  MessageCircleQuestionIcon,
  MessageSquareIcon,
  MonitorIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  WorkflowIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadShell } from "../../state/entities";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import { ProjectFavicon } from "../ProjectFavicon";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadProviderStack } from "../sidebar/SidebarThreadRow";
import {
  Menu,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Spinner } from "../ui/spinner";
import type { FeatureBoardHandlers } from "./FeatureBoards";
import {
  RelativeTime,
  WithThreadDetails,
  chatSince,
  chatTitle,
  type FeatureShelf,
} from "./FeatureCard";
import { FeatureNow } from "./FeatureNow";
import type { BoardWorkflow } from "./startFromBoard";

/** What a row's status icon says: its Work group, with Working split into its own states. */
export type WorkRowStatus = Exclude<WorkGroupId, "working"> | "working" | "waiting" | "failed";

export const WORK_LOOK: Record<
  WorkRowStatus,
  { readonly label: string; readonly icon: LucideIcon; readonly className: string }
> = {
  "needs-input": {
    label: "Needs input",
    icon: MessageCircleQuestionIcon,
    className: "text-warning-foreground",
  },
  working: { label: "Working", icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: { label: "Waiting", icon: CirclePauseIcon, className: "text-muted-foreground" },
  failed: { label: "Failed", icon: CircleAlertIcon, className: "text-error-foreground" },
  review: { label: WORK_GROUP_LABELS.review, icon: EyeIcon, className: "text-success-foreground" },
  done: {
    label: "Merged",
    icon: PullRequestGlyph.merged,
    className: PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName,
  },
};

export const GROUP_LOOK: Record<WorkGroupId, (typeof WORK_LOOK)[WorkRowStatus]> = {
  "needs-input": WORK_LOOK["needs-input"],
  working: WORK_LOOK.working,
  review: WORK_LOOK.review,
  done: { ...WORK_LOOK.done, label: WORK_GROUP_LABELS.done },
};

const workRowStatus = (group: WorkGroupId, status: FeatureStatus): WorkRowStatus =>
  status === "failed" || (group === "working" && status === "waiting") ? status : group;

/** A feature's Work group, status icon and pull request, from its threads. */
export function featureWork(
  card: EnvironmentFeatureCard,
  handlers: Pick<FeatureBoardHandlers, "threadsFor">,
) {
  const threads = handlers.threadsFor(card);
  const group = featureWorkGroup(card, threads);
  const progress = featureProgress(card, threads);
  return {
    group,
    status: workRowStatus(group, progress.status),
    thread: progress.thread,
    pullRequest: featurePullRequest(card, threads),
  };
}

export function WorkIcon(props: { readonly status: WorkRowStatus; readonly className?: string }) {
  const look = WORK_LOOK[props.status];
  return (
    <look.icon
      aria-label={look.label}
      className={cn("size-4 shrink-0", look.className, props.className)}
    />
  );
}

/** A group's shaded band: icon, label, count, and what it adds on the right. */
export function BoardBand(props: {
  readonly icon: LucideIcon;
  readonly iconClassName: string;
  readonly label: ReactNode;
  readonly count: number | null;
  readonly right?: ReactNode;
  readonly onAdd?: (() => void) | undefined;
  /** Given for a shelf, which folds. */
  readonly expanded?: boolean;
  readonly onToggle?: () => void;
}) {
  const Icon = props.onToggle ? ChevronRightIcon : props.icon;
  const head = (
    <>
      <Icon
        aria-hidden
        className={cn(
          "size-4 shrink-0",
          props.onToggle ? "text-muted-foreground" : props.iconClassName,
          props.onToggle && props.expanded && "rotate-90",
        )}
      />
      <span className="min-w-0 truncate">{props.label}</span>
      {props.count === null ? null : (
        <span className="font-normal text-muted-foreground tabular-nums">{props.count}</span>
      )}
    </>
  );
  return (
    <header className="flex h-9 shrink-0 items-center gap-2 bg-muted/50 ps-4 pe-3 text-sm font-medium">
      {props.onToggle ? (
        <button
          type="button"
          aria-expanded={props.expanded}
          onClick={props.onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none focus-visible:underline"
        >
          {head}
        </button>
      ) : (
        head
      )}
      <span className="ms-auto flex shrink-0 items-center gap-2.5 text-xs font-normal text-muted-foreground">
        {props.right}
        {props.onAdd ? (
          <button
            type="button"
            aria-label="New todo here"
            onClick={props.onAdd}
            className="-me-1 inline-flex size-6 cursor-pointer items-center justify-center rounded-md hover:bg-accent hover:text-foreground"
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </span>
    </header>
  );
}

export function PrChip(props: { readonly pullRequest: WorkPullRequest | null }) {
  const { pullRequest } = props;
  if (!pullRequest) return null;
  const look = PULL_REQUEST_STATE_PRESENTATION[pullRequest.state ?? "open"];
  return (
    <span
      aria-label={`PR #${pullRequest.number}, ${look.label.toLowerCase()}`}
      className="flex h-5.5 shrink-0 items-center gap-1 rounded-full border border-border/70 px-2 text-xs text-muted-foreground tabular-nums"
    >
      <look.Icon aria-hidden className={cn("size-3", look.toneClassName)} />#{pullRequest.number}
    </span>
  );
}

/** The machine a row's work runs on, or its project when the board shows several. */
export interface RowPlace {
  readonly project: EnvironmentProject | null;
  readonly machine: string | null;
  readonly showProject: boolean;
}

function PlaceCell(props: { readonly place: RowPlace }) {
  const { project, machine, showProject } = props.place;
  return (
    <span className="flex w-25 shrink-0 items-center gap-1.5 overflow-hidden text-xs text-muted-foreground max-sm:hidden">
      {showProject ? (
        project ? (
          <ProjectFavicon project={project} className="size-3.5 shrink-0" />
        ) : null
      ) : (
        <MonitorIcon aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="truncate">
        {showProject ? (project?.title ?? "Project") : (machine ?? "")}
      </span>
    </span>
  );
}

const placeText = (place: RowPlace) => (place.showProject ? place.project?.title : place.machine);

const iconButtonClassName =
  "inline-flex size-6.5 cursor-pointer items-center justify-center rounded-md text-foreground/80 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-accent";

/**
 * One 40px row. Every row has the same columns, so they line up across groups and tabs. On hover
 * the time gives way to the row's icon buttons; on a phone the columns fold into a second line.
 */
function BoardRow(props: {
  readonly rowKey: string;
  readonly id: ReactNode;
  readonly onId?: (() => void) | undefined;
  readonly status: ReactNode;
  readonly title: string;
  readonly note?: string | null | undefined;
  readonly noteClassName?: string | undefined;
  readonly extra?: ReactNode;
  readonly pullRequest: WorkPullRequest | null;
  readonly place: RowPlace;
  readonly agent: ReactNode;
  readonly time: ReactNode;
  readonly actions: ReactNode;
  /** Keeps the actions in view while the row's menu is open. */
  readonly menuOpen?: boolean;
  readonly onOpen: () => void;
  readonly onMenu?: (() => void) | undefined;
  readonly nested?: "mid" | "last" | undefined;
  readonly dimmed?: boolean;
}) {
  const idText = typeof props.id === "string" ? props.id : null;
  return (
    <div
      data-row-key={props.rowKey}
      data-menu-open={props.menuOpen ? "" : undefined}
      onContextMenu={
        props.onMenu
          ? (event) => {
              event.preventDefault();
              props.onMenu!();
            }
          : undefined
      }
      className={cn(
        // Off-screen rows skip layout and paint, like sidebar rows.
        "group/row relative flex h-10 min-w-0 items-center gap-2.5 ps-4 pe-3 text-sm [contain-intrinsic-size:auto_40px] [content-visibility:auto] hover:bg-accent/40 has-[[data-card-open]:focus-visible]:bg-accent/60 data-menu-open:bg-accent/40 max-sm:h-13",
        props.nested && "ps-14",
        props.dimmed && "opacity-70 hover:opacity-100",
      )}
    >
      {props.nested ? (
        <>
          <span
            aria-hidden
            className="pointer-events-none absolute start-8.5 top-0 h-5 w-3.5 rounded-es-md border-s border-b border-foreground/15"
          />
          {props.nested === "mid" ? (
            <span
              aria-hidden
              className="pointer-events-none absolute start-8.5 top-5 bottom-0 border-s border-foreground/15"
            />
          ) : null}
        </>
      ) : null}
      {props.onId ? (
        <button
          type="button"
          onClick={props.onId}
          className="relative z-10 w-11 shrink-0 cursor-pointer truncate text-left text-xs text-muted-foreground tabular-nums outline-none hover:text-foreground hover:underline focus-visible:underline max-sm:hidden"
        >
          {props.id}
        </button>
      ) : (
        <span className="w-11 shrink-0 truncate text-xs text-muted-foreground tabular-nums max-sm:hidden">
          {props.id}
        </span>
      )}
      {props.status}
      <span className="flex min-w-0 flex-1 items-baseline gap-2 max-sm:flex-col max-sm:items-stretch max-sm:gap-0">
        <button
          type="button"
          data-card-open
          onClick={props.onOpen}
          className="min-w-0 shrink cursor-default truncate text-left text-foreground outline-none after:absolute after:inset-0"
        >
          {props.title}
        </button>
        {props.note ? (
          <span
            className={cn(
              "shrink-0 truncate text-xs text-muted-foreground max-sm:hidden",
              props.noteClassName,
            )}
          >
            {props.note}
          </span>
        ) : null}
        <span className="max-sm:hidden">{props.extra}</span>
        <span className="truncate text-xs text-muted-foreground sm:hidden">
          {[idText, props.note, placeText(props.place)].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="flex w-30 shrink-0 justify-end max-sm:w-auto">
        <PrChip pullRequest={props.pullRequest} />
      </span>
      <PlaceCell place={props.place} />
      <span className="flex w-4.5 shrink-0 justify-center max-sm:hidden">{props.agent}</span>
      <span className="relative flex w-14 shrink-0 items-center justify-end text-xs text-muted-foreground tabular-nums">
        <span className="max-sm:hidden group-hover/row:hidden group-has-[:focus-visible]/row:hidden group-data-menu-open/row:hidden pointer-coarse:hidden">
          {props.time}
        </span>
        <span className="relative z-10 hidden items-center gap-0.5 group-hover/row:flex group-has-[:focus-visible]/row:flex group-data-menu-open/row:flex pointer-coarse:flex max-sm:flex">
          {props.actions}
        </span>
      </span>
    </div>
  );
}

/** Nobody works on it: the empty place an assignee would take. */
function Unassigned() {
  return (
    <span
      aria-label="Not started"
      className="size-4 shrink-0 rounded-full border border-dashed border-foreground/25"
    />
  );
}

function MoreButton(props: { readonly label: string }) {
  return (
    <MenuTrigger
      render={
        <button
          type="button"
          aria-label={props.label}
          className={iconButtonClassName}
          onClick={(event) => event.stopPropagation()}
        />
      }
    >
      <EllipsisIcon aria-hidden className="size-4" />
    </MenuTrigger>
  );
}

function IconAction(props: {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onClick: (event: MouseEvent) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={(event) => {
              event.stopPropagation();
              props.onClick(event);
            }}
            className={iconButtonClassName}
          />
        }
      >
        <props.icon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Snooze's presets, read fresh each time its submenu opens. */
function SnoozeItems(props: {
  readonly environmentId: EnvironmentFeatureCard["environmentId"];
  readonly onSnooze: (until: string) => void;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  // oxlint-disable-next-line react/purity -- Mounted only while the submenu is open, so each opening reads a fresh time.
  const presets = resolveSnoozePresets(new Date(), timestampFormat, props.environmentId);
  return presets.map((preset) => (
    <MenuItem
      key={preset.id}
      onClick={() => {
        const picked = pickSnoozePreset(presets, preset.id, timestampFormat, props.environmentId);
        if (picked) props.onSnooze(picked.snoozedUntil);
      }}
    >
      {preset.label}
      <MenuItemDetail>{preset.whenLabel}</MenuItemDetail>
    </MenuItem>
  ));
}

function ParkItems(props: {
  readonly shelf: FeatureShelf;
  readonly environmentId: EnvironmentFeatureCard["environmentId"];
  readonly onShelf: () => void;
  readonly onWake: () => void;
  readonly onSnooze: (until: string) => void;
}) {
  return (
    <>
      {props.shelf === "snoozed" ? (
        <MenuItem onClick={props.onWake}>Wake</MenuItem>
      ) : props.shelf === null ? (
        <MenuSub>
          <MenuSubTrigger>Snooze</MenuSubTrigger>
          <MenuSubPopup>
            <SnoozeItems environmentId={props.environmentId} onSnooze={props.onSnooze} />
          </MenuSubPopup>
        </MenuSub>
      ) : null}
      <MenuItem onClick={props.onShelf}>
        {props.shelf === "settled" ? "Un-settle" : "Settle"}
      </MenuItem>
    </>
  );
}

/** A feature in Work: its status, crew note, PR, machine, agent and when it last moved. */
export const WorkFeatureRow = memo(function WorkFeatureRow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly handlers: FeatureBoardHandlers;
  readonly shelf: FeatureShelf;
  readonly nested?: "mid" | "last" | undefined;
}) {
  const { card, handlers } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const lead = useThreadShell(
    card.leadThreadId ? scopeThreadRef(card.environmentId, card.leadThreadId) : null,
  );
  const work = featureWork(card, handlers);
  const who = work.thread?.feature?.member ?? "Lead";
  const note =
    work.status === "needs-input"
      ? work.thread?.hasPendingApprovals || work.thread?.pendingSubagentRequest === "approval"
        ? `${who} asks for approval`
        : `${who} asks a question`
      : work.status === "working"
        ? who
        : work.status === "waiting" || work.status === "failed"
          ? WORK_LOOK[work.status].label
          : null;
  const ref = featureRef(card);
  return (
    <WithThreadDetails
      shell={lead}
      project={handlers.projectFor(card)}
      status={
        <FeatureNow
          card={card}
          threadsFor={handlers.threadsFor}
          childCards={handlers.childrenFor(card)}
        />
      }
    >
      <BoardRow
        rowKey={featureCardKey(card)}
        id={ref ?? ""}
        onId={card.issue ? () => handlers.onShowIssue(card) : undefined}
        status={<WorkIcon status={work.status} />}
        title={card.title}
        note={note}
        noteClassName={work.status === "needs-input" ? "text-warning-foreground" : undefined}
        pullRequest={work.pullRequest}
        place={handlers.placeFor(card)}
        agent={lead ? <ThreadProviderStack thread={lead} /> : null}
        time={<RelativeTime timestamp={lead?.updatedAt ?? card.updatedAt} />}
        menuOpen={menuOpen}
        onOpen={() => handlers.onOpen(card)}
        onMenu={() => setMenuOpen(true)}
        nested={props.nested}
        dimmed={props.shelf !== null}
        actions={
          <>
            <IconAction
              label="Open thread"
              icon={ArrowUpRightIcon}
              onClick={() => handlers.onOpen(card)}
            />
            <Menu open={menuOpen} onOpenChange={setMenuOpen}>
              <MoreButton label={`${card.title} actions`} />
              <MenuPopup align="end" className="min-w-52">
                <MenuItem onClick={() => handlers.onOpen(card)}>Open thread</MenuItem>
                {card.issue ? (
                  <MenuItem onClick={() => handlers.onShowIssue(card)}>Show in Issues</MenuItem>
                ) : null}
                <MenuSeparator />
                {handlers.canShelf(card) ? (
                  <ParkItems
                    shelf={props.shelf}
                    environmentId={card.environmentId}
                    onShelf={() => handlers.onShelf(card)}
                    onWake={() => handlers.onWake(card)}
                    onSnooze={(until) => handlers.onSnooze(card, until)}
                  />
                ) : null}
                <MenuItem
                  onClick={(event) =>
                    handlers.onAction(card, card.status === "open" ? "close" : "reopen", event)
                  }
                >
                  {card.status === "open" ? "Close feature" : "Reopen feature"}
                </MenuItem>
              </MenuPopup>
            </Menu>
          </>
        }
      />
    </WithThreadDetails>
  );
});

/** A chat outside any feature, in Work beside the features. */
export const WorkChatRow = memo(function WorkChatRow(props: {
  readonly shell: EnvironmentThreadShell;
  readonly handlers: FeatureBoardHandlers;
  readonly shelf: FeatureShelf;
}) {
  const { shell, handlers } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const group = chatWorkGroup(shell);
  const status: WorkRowStatus = group === "done" && !threadPullRequest(shell) ? "done" : group;
  const doneWithoutPr = group === "done" && !threadPullRequest(shell);
  return (
    <WithThreadDetails shell={shell} project={handlers.projectFor(shell)}>
      <BoardRow
        rowKey={`${shell.environmentId}:${shell.id}`}
        id={<MessageSquareIcon aria-label="Thread" className="size-3.5" />}
        status={
          doneWithoutPr ? (
            <MessageSquareIcon
              aria-label="Done"
              className="size-4 shrink-0 text-muted-foreground"
            />
          ) : (
            <WorkIcon status={status} />
          )
        }
        title={chatTitle(shell)}
        note={group === "needs-input" ? "Needs input" : null}
        noteClassName="text-warning-foreground"
        pullRequest={threadPullRequest(shell)}
        place={handlers.placeFor(shell)}
        agent={<ThreadProviderStack thread={shell} />}
        time={<RelativeTime timestamp={chatSince(shell)} />}
        menuOpen={menuOpen}
        onOpen={() => handlers.onOpenChat(shell)}
        onMenu={() => setMenuOpen(true)}
        dimmed={props.shelf !== null}
        actions={
          <>
            <IconAction
              label="Open thread"
              icon={ArrowUpRightIcon}
              onClick={() => handlers.onOpenChat(shell)}
            />
            <Menu open={menuOpen} onOpenChange={setMenuOpen}>
              <MoreButton label={`${chatTitle(shell)} actions`} />
              <MenuPopup align="end" className="min-w-52">
                <MenuItem onClick={() => handlers.onOpenChat(shell)}>Open thread</MenuItem>
                <MenuSeparator />
                <ParkItems
                  shelf={props.shelf}
                  environmentId={shell.environmentId}
                  onShelf={() => handlers.onChatShelf(shell)}
                  onWake={() => handlers.onChatWake(shell)}
                  onSnooze={(until) => handlers.onChatSnooze(shell, until)}
                />
              </MenuPopup>
            </Menu>
          </>
        }
      />
    </WithThreadDetails>
  );
});

/** ▶'s menu: start on the last workflow, pick another, or edit the brief in the composer first. */
function StartItems(props: {
  readonly issue: EnvironmentIssue;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { issue, handlers } = props;
  const { workflow, workflows } = handlers.workflowsFor(issue);
  return (
    <>
      <MenuItem onClick={() => handlers.onStartTodo(issue, workflow)}>
        <PlayIcon aria-hidden />
        Start
        <MenuItemDetail>{workflow.name}</MenuItemDetail>
        <MenuShortcut>S</MenuShortcut>
      </MenuItem>
      {workflows.length > 0 ? (
        <MenuSub>
          <MenuSubTrigger>
            <WorkflowIcon aria-hidden />
            Start with workflow
          </MenuSubTrigger>
          <MenuSubPopup>
            {workflows.map((choice: BoardWorkflow) => (
              <MenuItem key={choice.id} onClick={() => handlers.onStartTodo(issue, choice)}>
                {choice.name}
                {choice.id === workflow.id ? <MenuItemDetail>last used</MenuItemDetail> : null}
              </MenuItem>
            ))}
          </MenuSubPopup>
        </MenuSub>
      ) : null}
      <MenuItem onClick={() => handlers.onEditBrief(issue)}>
        <PencilIcon aria-hidden />
        Edit brief, then start
      </MenuItem>
    </>
  );
}

/**
 * An open issue or ticket. With work on it, it reads that feature's status, PR and agent, and
 * opens its Work row. Nobody's started it: ▶ starts it here, and ⋯ has the rest.
 */
export const IssueRow = memo(function IssueRow(props: {
  readonly item: IssueTreeItem;
  readonly handlers: FeatureBoardHandlers;
  readonly starting: boolean;
  readonly nested?: "mid" | "last" | undefined;
}) {
  const { handlers } = props;
  const { issue } = props.item;
  const [menuOpen, setMenuOpen] = useState(false);
  const feature = handlers.featureFor(issue);
  const started = feature !== null && feature.leadThreadId !== null;
  const lead = useThreadShell(
    started ? scopeThreadRef(feature.environmentId, feature.leadThreadId!) : null,
  );
  const work = started ? featureWork(feature, handlers) : null;
  const start = started ? undefined : () => handlers.onStartTodo(issue);
  const subIssues = issue.subIssues;
  return (
    <BoardRow
      rowKey={issueKey(issue)}
      id={issueRef(issue)}
      status={
        props.starting && !started ? (
          <Spinner aria-label="Starting" className="size-4 shrink-0" />
        ) : work ? (
          <WorkIcon status={work.status} />
        ) : (
          <CircleIcon aria-label="Open" className="size-4 shrink-0 text-muted-foreground/70" />
        )
      }
      title={issue.title}
      note={props.starting && !started ? "Starting…" : null}
      extra={
        subIssues ? (
          <span className="flex h-5.5 items-center gap-1 rounded-full border border-border/70 px-2 text-xs text-muted-foreground tabular-nums">
            <ListTreeIcon aria-hidden className="size-3" />
            {subIssues.completed}/{subIssues.total}
          </span>
        ) : null
      }
      pullRequest={work?.pullRequest ?? null}
      place={handlers.placeFor(issue)}
      agent={lead ? <ThreadProviderStack thread={lead} /> : <Unassigned />}
      time={<RelativeTime timestamp={issue.updatedAt} />}
      menuOpen={menuOpen}
      onOpen={() =>
        feature && started ? handlers.onShowWork(feature) : handlers.onOpenTodo(issue)
      }
      onMenu={() => setMenuOpen(true)}
      nested={props.nested}
      actions={
        <>
          {start ? (
            <IconAction
              label={`Start on ${handlers.workflowsFor(issue).workflow.name}`}
              icon={PlayIcon}
              onClick={start}
            />
          ) : (
            <IconAction
              label="Show in Work"
              icon={ArrowUpRightIcon}
              onClick={() => feature && handlers.onShowWork(feature)}
            />
          )}
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MoreButton label={`${issueRef(issue)} actions`} />
            <MenuPopup align="end" className="min-w-60">
              {started ? (
                <MenuItem onClick={() => handlers.onShowWork(feature)}>Show in Work</MenuItem>
              ) : (
                <StartItems issue={issue} handlers={handlers} />
              )}
              <MenuSeparator />
              <MenuItem onClick={() => handlers.onOpenTodo(issue)}>
                {issue.ticketId ? "Open ticket" : "Open issue"}
              </MenuItem>
              {issue.url ? (
                <MenuItem onClick={() => handlers.onOpenExternal(issue.url)}>
                  <ArrowUpRightIcon aria-hidden />
                  Open on GitHub
                </MenuItem>
              ) : null}
              <MenuItem onClick={() => handlers.onCloseTodo(issue)}>
                <XIcon aria-hidden />
                {issue.ticketId ? "Close ticket" : "Close issue"}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    />
  );
});

/** A feature nobody has started and that has no issue: ▶ starts its lead. */
export const UnstartedFeatureRow = memo(function UnstartedFeatureRow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { card, handlers } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <BoardRow
      rowKey={featureCardKey(card)}
      id={featureRef(card) ?? ""}
      status={
        <CircleIcon aria-label="Not started" className="size-4 shrink-0 text-muted-foreground/70" />
      }
      title={card.title}
      pullRequest={null}
      place={handlers.placeFor(card)}
      agent={<Unassigned />}
      time={<RelativeTime timestamp={card.updatedAt} />}
      menuOpen={menuOpen}
      onOpen={() => handlers.onOpen(card)}
      onMenu={() => setMenuOpen(true)}
      actions={
        <>
          <IconAction
            label="Start feature"
            icon={PlayIcon}
            onClick={(event) => handlers.onAction(card, "start", event)}
          />
          <Menu open={menuOpen} onOpenChange={setMenuOpen}>
            <MoreButton label={`${card.title} actions`} />
            <MenuPopup align="end" className="min-w-52">
              <MenuItem onClick={(event) => handlers.onAction(card, "start", event)}>
                <PlayIcon aria-hidden />
                Start feature
              </MenuItem>
              <MenuItem onClick={(event) => handlers.onAction(card, "close", event)}>
                <XIcon aria-hidden />
                Close feature
              </MenuItem>
            </MenuPopup>
          </Menu>
        </>
      }
    />
  );
});

/** A parent's closed sub-issues, folded into one line under its open ones. */
export function ClosedPartsLine(props: { readonly count: number }) {
  return (
    <div className="relative flex h-8 items-center ps-14 text-xs text-muted-foreground">
      <span
        aria-hidden
        className="pointer-events-none absolute start-8.5 top-0 h-4 w-3.5 rounded-es-md border-s border-b border-foreground/15"
      />
      {props.count} closed sub-issue{props.count === 1 ? "" : "s"}
    </div>
  );
}

/** A milestone's progress: done (closed) in violet, in review in green, as a small pie. */
export function MilestonePie(props: {
  readonly done: number;
  readonly review: number;
  readonly total: number;
}) {
  const total = Math.max(props.total, 1);
  const done = (props.done / total) * 100;
  const review = done + (props.review / total) * 100;
  return (
    <span
      aria-hidden
      className="size-3.5 shrink-0 rounded-full"
      style={{
        background: `conic-gradient(var(--color-violet-400) 0 ${done}%, var(--color-success) ${done}% ${review}%, color-mix(in oklab, var(--color-foreground) 12%, transparent) ${review}%)`,
      }}
    />
  );
}

/** A long list shows its first page, then a row to show the rest. */
export function PagedRows<T>(props: {
  readonly items: ReadonlyArray<T>;
  readonly pageSize: number | null;
  readonly revealIndex?: number;
  readonly render: (item: T, index: number) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible =
    props.pageSize !== null && !expanded
      ? props.items.slice(0, Math.max(props.pageSize, (props.revealIndex ?? -1) + 1))
      : props.items;
  const hidden = props.items.length - visible.length;
  return (
    <>
      {visible.map(props.render)}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex h-8.5 w-full cursor-pointer items-center ps-18 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          Show {hidden} more
        </button>
      ) : null}
    </>
  );
}

/** ↑ and ↓ move between rows, and Enter opens the focused one. */
export function onRowListKeyDown(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-card-open]")];
  const index = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)] ?? rows[index === -1 ? 0 : index];
  if (!next) return;
  event.preventDefault();
  next.focus();
}
