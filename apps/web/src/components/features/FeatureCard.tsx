import {
  FEATURE_CARD_ACTION_LABELS,
  FEATURE_STATUS_LABELS,
  featureCardQuickActions,
  featureProgress,
  featureRef,
  threadBoardColumn,
  threadPullRequest,
  type EnvironmentFeatureCard,
  type FeatureCardActionId,
  type FeatureColumn,
  type FeatureStatus,
} from "@t3tools/client-runtime/state/crew-board";
import { issueRef, type EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { featureIssueRef, type EnvironmentId } from "@t3tools/contracts";
import {
  AlarmClockOffIcon,
  CheckIcon,
  GitBranchIcon,
  ListTreeIcon,
  MessageSquareIcon,
  NotebookTextIcon,
  PlayIcon,
  Undo2Icon,
  type LucideIcon,
} from "lucide-react";
import {
  memo,
  useState,
  type DragEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";

import { cn } from "../../lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadShell } from "../../state/entities";
import { formatRelativeTime } from "../../timestampFormat";
import { STATUS_LOOK } from "../crew/CrewRosterIcon";
import { FeatureIssueIcon } from "../crew/FeatureIssueIcon";
import { PartOf } from "./IssueStructure";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import {
  SnoozeMenuButton,
  ThreadDetailsHoverCard,
  ThreadProviderStack,
} from "../sidebar/SidebarThreadRow";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { MiddleTruncate } from "../ui/middle-truncate";
import type { FeatureBoardHandlers } from "./FeatureBoards";
import { CloseTodoButton } from "./todoState";
import { PrChip, WORK_LOOK, WorkIcon, featureWork } from "./BoardRows";
import { Spinner } from "../ui/spinner";

interface FeatureStatusLook {
  readonly label: string;
  readonly className: string;
  readonly icon: LucideIcon;
}

const statusLook = (status: FeatureStatus): FeatureStatusLook => ({
  label: FEATURE_STATUS_LABELS[status],
  ...STATUS_LOOK[status],
});

/**
 * Where a feature stands, from its lead's and crew's threads, and the thread that puts it there:
 * the one waiting on you, else the one running.
 */
export function featureStatus(
  card: EnvironmentFeatureCard,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): {
  readonly column: FeatureColumn;
  readonly status: FeatureStatusLook;
  readonly thread: EnvironmentThreadShell | null;
} {
  const progress = featureProgress(card, threads);
  return { ...progress, status: statusLook(progress.status) };
}

// Self-ticking like the sidebar's, so a working card re-renders only this label each second.
export function WorkingDuration(props: { readonly startedAt: string }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">
      {formatWorkingDurationLabel(nowMs - Date.parse(props.startedAt))}
    </span>
  );
}

export function RelativeTime(props: { readonly timestamp: string }) {
  const nowMinute = useNowMinute();
  return (
    <span className="tabular-nums">
      {formatRelativeTime(props.timestamp, Date.parse(`${nowMinute}:00.000Z`))?.value}
    </span>
  );
}

const cardClassName =
  // Off-screen cards skip layout and paint, like sidebar rows.
  "group/card relative flex w-full min-w-0 flex-col rounded-lg border bg-card px-3 py-2.5 text-xs shadow-xs/5 [contain-intrinsic-size:auto_88px] [content-visibility:auto] hover:bg-accent/40 has-[[data-card-open]:focus-visible]:ring-2 has-[[data-card-open]:focus-visible]:ring-ring has-[[data-card-open]:focus-visible]:ring-inset";

/** The card's title, stretched over the whole card so a click anywhere opens it. */
function CardTitle(props: { readonly title: string; readonly onOpen: () => void }) {
  return (
    <button
      type="button"
      data-card-open
      onClick={props.onOpen}
      className="mt-1 line-clamp-2 min-w-0 cursor-default text-left text-sm font-medium leading-snug text-foreground outline-none after:absolute after:inset-0 after:rounded-lg"
    >
      {props.title}
    </button>
  );
}

/** The top line: project, then status, the way a sidebar row starts. */
function CardHeader(props: {
  readonly project: EnvironmentProject | null;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex h-5 min-w-0 items-center gap-1.5">
      {props.project ? (
        <ProjectFavicon project={props.project} className="size-4 shrink-0" />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-secondary-label">
        {props.project?.title ?? "Project"}
      </span>
      {props.children}
    </div>
  );
}

/**
 * A status that a hover swaps for the sidebar's Settle or Un-settle control. Touch screens,
 * which have no hover, always show the control.
 */
function StatusWithControl(props: { readonly status: ReactNode; readonly control: ReactNode }) {
  if (!props.control) return props.status;
  return (
    <span className="relative z-10 flex shrink-0 items-center justify-end">
      <span className="group-hover/card:opacity-0 group-has-[[data-card-control]:focus-visible]/card:opacity-0 pointer-coarse:opacity-0">
        {props.status}
      </span>
      <span className="pointer-events-none absolute right-0 opacity-0 group-hover/card:pointer-events-auto group-hover/card:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100">
        {props.control}
      </span>
    </span>
  );
}

/** Wakes a snoozed feature, the board's way back out of Snoozed. */
function WakeControl(props: { readonly onClick: () => void }) {
  return (
    <button
      type="button"
      data-card-control
      onClick={props.onClick}
      className="-mr-1 inline-flex h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <AlarmClockOffIcon aria-hidden className="size-3.5" />
      Wake
    </button>
  );
}

function ShelfControl(props: { readonly settled: boolean; readonly onClick: () => void }) {
  const Icon = props.settled ? Undo2Icon : CheckIcon;
  return (
    <button
      type="button"
      data-card-control
      onClick={props.onClick}
      className="-mr-1 inline-flex h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <Icon aria-hidden className="size-3.5" />
      {props.settled ? "Un-settle" : "Settle"}
    </button>
  );
}

/** Where a feature is parked, like a thread: snoozed, settled, or neither. */
export type FeatureShelf = "snoozed" | "settled" | null;

/**
 * The sidebar row's Snooze and Settle. Something snoozed offers Wake and something settled
 * Un-settle instead.
 */
function ParkControls(props: {
  readonly shelf: FeatureShelf;
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** False while it waits on you, which the server won't snooze. */
  readonly snoozable: boolean;
  readonly onShelf: () => void;
  readonly onWake: () => void;
  readonly onSnooze: (snoozedUntil: string) => void;
}) {
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  if (props.shelf === "snoozed") return <WakeControl onClick={props.onWake} />;
  if (props.shelf === "settled") return <ShelfControl settled onClick={props.onShelf} />;
  return (
    <span className="flex h-5 items-center">
      {props.snoozable ? (
        <SnoozeMenuButton
          open={snoozeOpen}
          onOpenChange={setSnoozeOpen}
          onSnooze={(preset) => props.onSnooze(preset.snoozedUntil)}
          timestampFormat={timestampFormat}
          environmentId={props.environmentId}
          label={props.label}
        />
      ) : null}
      <ShelfControl settled={false} onClick={props.onShelf} />
    </span>
  );
}

/** A feature's Snooze and Settle act on the threads of its row. */
export function FeatureParkControls(props: {
  readonly card: EnvironmentFeatureCard;
  readonly shelf: FeatureShelf;
  readonly handlers: Pick<FeatureBoardHandlers, "canShelf" | "onShelf" | "onWake" | "onSnooze">;
}) {
  const { card, handlers } = props;
  if (!handlers.canShelf(card)) return null;
  return (
    <ParkControls
      shelf={props.shelf}
      environmentId={card.environmentId}
      label="Snooze feature"
      snoozable
      onShelf={() => handlers.onShelf(card)}
      onWake={() => handlers.onWake(card)}
      onSnooze={(until) => handlers.onSnooze(card, until)}
    />
  );
}

/** A chat's Snooze and Settle, the same as its sidebar row's. */
function ChatParkControls(props: {
  readonly shell: EnvironmentThreadShell;
  readonly shelf: FeatureShelf;
  readonly handlers: Pick<FeatureBoardHandlers, "onChatShelf" | "onChatWake" | "onChatSnooze">;
}) {
  const { shell, handlers } = props;
  return (
    <ParkControls
      shelf={props.shelf}
      environmentId={shell.environmentId}
      label="Snooze thread"
      snoozable={threadBoardColumn(shell) !== "needs-you"}
      onShelf={() => handlers.onChatShelf(shell)}
      onWake={() => handlers.onChatWake(shell)}
      onSnooze={(until) => handlers.onChatSnooze(shell, until)}
    />
  );
}

/** The sidebar row's hover card over a board card or row that has a thread to describe. */
export function WithThreadDetails(props: {
  readonly shell: EnvironmentThreadShell | null;
  readonly project: EnvironmentProject | null;
  /** While true, a nested trigger shows its own details instead. */
  readonly disabled?: boolean;
  /** Where its feature stands now, under the card's title. */
  readonly status?: ReactNode;
  readonly children: ReactElement<{ readonly children?: ReactNode }>;
}) {
  if (!props.shell) return props.children;
  return (
    <Tooltip disabled={props.disabled ?? false}>
      <TooltipTrigger render={props.children}>{props.children.props.children}</TooltipTrigger>
      <ThreadDetailsHoverCard thread={props.shell} project={props.project} status={props.status} />
    </Tooltip>
  );
}

/** A chat's title: a bot request is named by the request, as its sidebar row is. */
export const chatTitle = (shell: EnvironmentThreadShell) => shell.crewRequest?.title || shell.title;

/** When a finished chat last moved, for the time it shows in Done. */
export const chatSince = (shell: EnvironmentThreadShell) =>
  shell.latestRun?.completedAt ?? shell.updatedAt;

/** The words a chat shows for its column, or null in Done, which shows its time instead. */
function chatStatus(shell: EnvironmentThreadShell): FeatureStatusLook | null {
  switch (threadBoardColumn(shell)) {
    case "needs-you":
      return statusLook("needs-input");
    case "working":
      return statusLook("working");
    case "done":
      return null;
  }
}

/** A chat thread outside any feature, in the column its sidebar row's status puts it. */
export const ChatCard = memo(function ChatCard(props: {
  readonly shell: EnvironmentThreadShell;
  readonly project: EnvironmentProject | null;
  readonly shelf: FeatureShelf;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { shell } = props;
  const status = chatStatus(shell);
  const pullRequest = threadPullRequest(shell);
  const workingSince = status?.label === "Working" ? resolveThreadWorkingStartedAt(shell) : null;
  const StatusIcon = status?.icon;
  const statusLabel =
    status && StatusIcon ? (
      <span className={cn("inline-flex shrink-0 items-center gap-1 font-medium", status.className)}>
        <StatusIcon aria-hidden className="size-4 shrink-0" />
        {status.label}
        {workingSince ? <WorkingDuration startedAt={workingSince} /> : null}
      </span>
    ) : (
      <span className="text-secondary-label">
        <RelativeTime timestamp={chatSince(shell)} />
      </span>
    );
  return (
    <WithThreadDetails shell={shell} project={props.project}>
      <div
        className={cn(
          cardClassName,
          "border-border/70 hover:border-border",
          props.shelf !== null && "opacity-70 hover:opacity-100",
        )}
      >
        <CardHeader project={props.project}>
          <StatusWithControl
            status={statusLabel}
            control={
              <ChatParkControls shell={shell} shelf={props.shelf} handlers={props.handlers} />
            }
          />
        </CardHeader>
        <CardTitle title={chatTitle(shell)} onOpen={() => props.handlers.onOpenChat(shell)} />
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-secondary-label">
          <MessageSquareIcon aria-label="Thread" className="size-3 shrink-0" />
          {shell.issue ? (
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              <FeatureIssueIcon issue={shell.issue} className="size-3" />
              {featureIssueRef(shell.issue)}
            </span>
          ) : null}
          {shell.branch ? (
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <GitBranchIcon aria-hidden className="size-3 shrink-0" />
              <MiddleTruncate value={shell.branch} showTitle={false} />
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <PrChip pullRequest={pullRequest} />
          <ThreadProviderStack thread={shell} />
        </div>
      </div>
    </WithThreadDetails>
  );
});

export const FeatureCard = memo(function FeatureCard(props: {
  readonly card: EnvironmentFeatureCard;
  readonly project: EnvironmentProject | null;
  /** In the Settled shelf: receded, with Un-settle in place of Settle. */
  readonly settled: boolean;
  readonly draggable: boolean;
  readonly onOpen: (card: EnvironmentFeatureCard) => void;
  readonly onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) => void;
  readonly onAction: (
    card: EnvironmentFeatureCard,
    action: FeatureCardActionId,
    event: MouseEvent,
  ) => void;
  /** Snooze and Settle, swapped in for the status on hover. */
  readonly parkControls: ReactNode;
  /** Its child features, listed under its own details; each shows its own on hover. */
  readonly subfeatures?: ReactNode;
  /** Where it stands now, in its hover card. */
  readonly now?: ReactNode;
  /** Its Work group, status and pull request, as its row in the list reads. */
  readonly work: ReturnType<typeof featureWork>;
  readonly onDragStart?: (card: EnvironmentFeatureCard, event: DragEvent) => void;
}) {
  const { card } = props;
  // The lead's thread carries the feature's branch and pull request.
  const shell = useThreadShell(
    card.leadThreadId ? scopeThreadRef(card.environmentId, card.leadThreadId) : null,
  );
  const { pullRequest, thread } = props.work;
  const notStarted = card.leadThreadId === null;
  const workingSince =
    props.work.status === "working" && thread ? resolveThreadWorkingStartedAt(thread) : null;
  const actions = featureCardQuickActions(card);
  const look = WORK_LOOK[props.work.status];
  const statusLabel =
    props.work.group === "done" || notStarted ? (
      <span className="text-secondary-label">
        <RelativeTime timestamp={card.updatedAt} />
      </span>
    ) : (
      <span className={cn("inline-flex shrink-0 items-center gap-1 font-medium", look.className)}>
        <look.icon aria-hidden className="size-4 shrink-0" />
        {look.label}
        {workingSince ? <WorkingDuration startedAt={workingSince} /> : null}
      </span>
    );
  const member = thread?.feature?.member;
  const ref = featureRef(card);
  const meta = ref || pullRequest || shell;
  const [overSubfeature, setOverSubfeature] = useState(false);
  return (
    <WithThreadDetails
      shell={shell}
      project={props.project}
      disabled={overSubfeature}
      status={props.now}
    >
      <div
        draggable={props.draggable}
        onDragStart={props.onDragStart ? (event) => props.onDragStart!(card, event) : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          props.onMenu(card, event);
        }}
        className={cn(
          cardClassName,
          notStarted ? "border-dashed" : "border-border/70 hover:border-border",
          props.settled && "opacity-70 hover:opacity-100",
        )}
      >
        <CardHeader project={props.project}>
          <StatusWithControl status={statusLabel} control={props.parkControls} />
        </CardHeader>
        <CardTitle title={card.title} onOpen={() => props.onOpen(card)} />
        {member ? <p className="mt-0.5 min-w-0 truncate text-muted-foreground">{member}</p> : null}
        {meta ? (
          <div className="mt-1 flex min-w-0 items-center gap-1.5 text-secondary-label">
            {card.issue ? (
              <span className="flex shrink-0 items-center gap-1 tabular-nums">
                <FeatureIssueIcon issue={card.issue} className="size-3" />
                {ref}
              </span>
            ) : ref ? (
              <span className="shrink-0 tabular-nums">{ref}</span>
            ) : null}
            {shell?.branch ? (
              <span className="flex min-w-0 flex-1 items-center gap-1">
                <GitBranchIcon aria-hidden className="size-3 shrink-0" />
                <MiddleTruncate value={shell.branch} showTitle={false} />
              </span>
            ) : (
              <span className="flex-1" />
            )}
            <PrChip pullRequest={pullRequest} />
            {shell ? <ThreadProviderStack thread={shell} /> : null}
          </div>
        ) : null}
        {props.subfeatures ? (
          <div
            onPointerEnter={() => setOverSubfeature(true)}
            onPointerLeave={() => setOverSubfeature(false)}
          >
            {props.subfeatures}
          </div>
        ) : null}
        {actions.length > 0 ? (
          <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
            {actions.map((action) => (
              <Button
                key={action}
                size="xs"
                variant="outline"
                onClick={(event) => props.onAction(card, action, event)}
              >
                {action === "start" ? <PlayIcon aria-hidden /> : null}
                {FEATURE_CARD_ACTION_LABELS[action]}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    </WithThreadDetails>
  );
});

/**
 * An open issue or ticket in Issues' columns. With work on it, it shows that feature's status
 * and PR and opens its Work row; otherwise ▶ starts it, and ⋯ has the rest.
 */
export const TodoCard = memo(function TodoCard(props: {
  readonly issue: EnvironmentIssue;
  readonly project: EnvironmentProject | null;
  readonly handlers: FeatureBoardHandlers;
  readonly starting: boolean;
}) {
  const { issue, handlers } = props;
  const feature = handlers.featureFor(issue);
  const started = feature !== null && feature.leadThreadId !== null;
  const work = started ? featureWork(feature, handlers) : null;
  const labels = issue.labels.slice(0, 2);
  return (
    <div className={cn(cardClassName, started ? "border-border/70" : "border-dashed")}>
      <CardHeader project={props.project}>
        <span className="flex shrink-0 items-center gap-1 text-secondary-label tabular-nums">
          {props.starting && !started ? (
            <Spinner aria-label="Starting" className="size-3.5" />
          ) : work ? (
            <WorkIcon status={work.status} className="size-3.5" />
          ) : issue.ticketId ? (
            <NotebookTextIcon aria-label="Ticket" className="size-3" />
          ) : (
            <FeatureIssueIcon issue={issue} className="size-3" />
          )}
          {issueRef(issue)}
        </span>
      </CardHeader>
      <CardTitle
        title={issue.title}
        onOpen={() =>
          feature && started ? handlers.onShowWork(feature) : handlers.onOpenTodo(issue)
        }
      />
      {issue.parent !== null || labels.length > 0 || issue.subIssues || work?.pullRequest ? (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-secondary-label">
          {issue.parent !== null ? (
            <PartOf parent={issue.parent} title={null} variant="inline" />
          ) : null}
          {issue.subIssues ? <PartsProgress {...issue.subIssues} /> : null}
          {labels.map((label) => (
            <span key={label.name} className="flex min-w-0 items-center gap-1">
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: `#${label.color}` }}
              />
              <span className="truncate">{label.name}</span>
            </span>
          ))}
          <span className="flex-1" />
          <PrChip pullRequest={work?.pullRequest ?? null} />
        </div>
      ) : null}
      {started || props.starting ? null : (
        <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
          <Button size="xs" variant="outline" onClick={() => handlers.onStartTodo(issue)}>
            <PlayIcon aria-hidden />
            Start
          </Button>
          <CloseTodoButton todo={issue} />
        </div>
      )}
    </div>
  );
});
/** `0/3`: a parent's closed sub-issues of all of them. */
function PartsProgress(props: { readonly completed: number; readonly total: number }) {
  return (
    <span aria-label="Sub-issues closed" className="flex shrink-0 items-center gap-1 tabular-nums">
      <ListTreeIcon aria-hidden className="size-3" />
      {props.completed}/{props.total}
    </span>
  );
}
