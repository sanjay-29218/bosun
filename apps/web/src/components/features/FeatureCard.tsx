import {
  FEATURE_CARD_ACTION_LABELS,
  featureCardQuickActions,
  ordinal,
  type EnvironmentFeatureCard,
  type FeatureCardActionId,
} from "@t3tools/client-runtime/state/crew-board";
import { issueRef, type EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { featureIssueRef } from "@t3tools/contracts";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CircleSlashIcon,
  ClockIcon,
  GitBranchIcon,
  MessageCircleQuestionIcon,
  MilestoneIcon,
  NotebookTextIcon,
  PauseIcon,
  PlayIcon,
  ShieldQuestionIcon,
  Undo2Icon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import { memo, type DragEvent, type MouseEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useNowSecond } from "../../hooks/useNowSecond";
import { useThreadShell } from "../../state/entities";
import { formatRelativeTime } from "../../timestampFormat";
import { FeatureIssueIcon } from "../crew/FeatureIssue";
import { ProjectFavicon } from "../ProjectFavicon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { MiddleTruncate } from "../ui/middle-truncate";

interface FeatureStatus {
  readonly label: string;
  readonly className: string;
  readonly icon: LucideIcon;
}

/**
 * Status words and icons reuse the sidebar's (sky working, amber approval, indigo input, red
 * failed), so a feature reads the same on the board as its thread does in the sidebar.
 */
export function featureStatus(
  card: EnvironmentFeatureCard,
  queuePosition: number | undefined,
): FeatureStatus {
  if (!card.started && card.state !== "done" && card.state !== "cancelled")
    return { label: "Not started", className: "text-muted-foreground", icon: CircleIcon };
  switch (card.state) {
    case "working":
      return card.stage?.takenOver
        ? { label: "Taken over", className: "text-warning-foreground", icon: UserRoundIcon }
        : { label: "Working", className: "text-info-foreground", icon: CircleDashedIcon };
    case "queued":
      return {
        label: queuePosition ? `Queued · ${ordinal(queuePosition)}` : "Queued",
        className: "text-muted-foreground",
        icon: ClockIcon,
      };
    case "approval":
      return { label: "Approval", className: "text-warning-foreground", icon: ShieldQuestionIcon };
    case "input":
      return {
        label: "Input",
        className: "text-indigo-600 dark:text-indigo-300",
        icon: MessageCircleQuestionIcon,
      };
    case "your-call":
      return { label: "Your call", className: "text-warning-foreground", icon: UserRoundIcon };
    case "failed":
      return { label: "Failed", className: "text-error-foreground", icon: CircleAlertIcon };
    case "paused":
      return { label: "Paused", className: "text-muted-foreground", icon: PauseIcon };
    case "cancelled":
      return { label: "Stopped", className: "text-muted-foreground", icon: CircleSlashIcon };
    case "done":
      return { label: "Done", className: "text-success-foreground", icon: CircleCheckIcon };
  }
}

/** States whose card says what it waits on: the question, the failure, the decision. */
const WAITING_STATES = new Set<EnvironmentFeatureCard["state"]>([
  "approval",
  "input",
  "your-call",
  "failed",
]);

// Self-ticking like the sidebar's, so a working card re-renders only this label each second.
function WorkingDuration(props: { readonly startedAt: string }) {
  const nowMs = useNowSecond();
  return (
    <span className="tabular-nums">
      {formatWorkingDurationLabel(nowMs - Date.parse(props.startedAt))}
    </span>
  );
}

function RelativeTime(props: { readonly timestamp: string }) {
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

export const FeatureCard = memo(function FeatureCard(props: {
  readonly card: EnvironmentFeatureCard;
  readonly project: EnvironmentProject | null;
  readonly queuePosition: number | undefined;
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
  /** Settles or un-settles a finished feature; absent where the server can't. */
  readonly onShelf: ((card: EnvironmentFeatureCard) => void) | null;
  readonly onDragStart?: (card: EnvironmentFeatureCard, event: DragEvent) => void;
}) {
  const { card } = props;
  // Each card follows only its own stage thread, so a streaming stage repaints one card.
  const shell = useThreadShell(
    card.threadId ? scopeThreadRef(card.environmentId, card.threadId) : null,
  );
  const pullRequest = shell?.linkedPullRequest ?? shell?.branchPullRequest ?? null;
  const status = featureStatus(card, props.queuePosition);
  const closed = card.state === "done" || card.state === "cancelled";
  const workingSince =
    card.state === "working" && !card.stage?.takenOver && shell
      ? resolveThreadWorkingStartedAt(shell)
      : null;
  const actions = featureCardQuickActions(card);
  const StatusIcon = status.icon;
  const statusLabel =
    card.state === "done" || !card.started ? (
      <span className="text-secondary-label">
        <RelativeTime timestamp={card.stateSince} />
      </span>
    ) : (
      <span className={cn("inline-flex shrink-0 items-center gap-1 font-medium", status.className)}>
        <StatusIcon aria-hidden className="size-4 shrink-0" />
        {status.label}
        {workingSince ? <WorkingDuration startedAt={workingSince} /> : null}
      </span>
    );
  const meta = card.issue || pullRequest || shell?.branch;
  return (
    <div
      draggable={props.draggable}
      onDragStart={props.onDragStart ? (event) => props.onDragStart!(card, event) : undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onMenu(card, event);
      }}
      className={cn(
        cardClassName,
        card.started || closed ? "border-border/70 hover:border-border" : "border-dashed",
        props.settled && "opacity-70 hover:opacity-100",
      )}
    >
      <CardHeader project={props.project}>
        <StatusWithControl
          status={statusLabel}
          control={
            closed && props.onShelf ? (
              <ShelfControl settled={props.settled} onClick={() => props.onShelf!(card)} />
            ) : null
          }
        />
      </CardHeader>
      <CardTitle title={card.title} onOpen={() => props.onOpen(card)} />
      {card.detail && WAITING_STATES.has(card.state) ? (
        <p className="mt-0.5 line-clamp-2 min-w-0 text-muted-foreground">{card.detail}</p>
      ) : null}
      {meta ? (
        <div className="mt-1 flex min-w-0 items-center gap-1.5 text-secondary-label">
          {card.issue ? (
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              <FeatureIssueIcon issue={card.issue} className="size-3" />
              {featureIssueRef(card.issue)}
            </span>
          ) : null}
          {shell?.branch ? (
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <GitBranchIcon aria-hidden className="size-3 shrink-0" />
              <MiddleTruncate value={shell.branch} showTitle={false} />
            </span>
          ) : (
            <span className="flex-1" />
          )}
          {pullRequest ? (
            <span className="flex shrink-0 items-center gap-1 tabular-nums">
              <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
              {pullRequest.number}
            </span>
          ) : null}
        </div>
      ) : null}
      {actions.length > 0 ? (
        <div className="relative z-10 mt-2 flex flex-wrap gap-1.5">
          {actions.map((action, index) => (
            <Button
              key={action}
              size="xs"
              variant={index === 0 && WAITING_STATES.has(card.state) ? "default" : "outline"}
              onClick={(event) => props.onAction(card, action, event)}
            >
              {action === "start" ? <PlayIcon aria-hidden /> : null}
              {FEATURE_CARD_ACTION_LABELS[action]}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
});

/** An open issue or ticket no feature works on yet, in Todo; Start feature begins one. */
export const TodoCard = memo(function TodoCard(props: {
  readonly issue: EnvironmentIssue;
  readonly project: EnvironmentProject | null;
  readonly onOpen: (issue: EnvironmentIssue) => void;
  readonly onStart: (issue: EnvironmentIssue) => void;
}) {
  const { issue } = props;
  const labels = issue.labels.slice(0, 2);
  return (
    <div className={cn(cardClassName, "border-dashed")}>
      <CardHeader project={props.project}>
        <span className="flex shrink-0 items-center gap-1 text-secondary-label tabular-nums">
          {issue.ticketId ? (
            <NotebookTextIcon aria-label="Ticket" className="size-3" />
          ) : (
            <FeatureIssueIcon issue={issue} className="size-3" />
          )}
          {issueRef(issue)}
        </span>
      </CardHeader>
      <CardTitle title={issue.title} onOpen={() => props.onOpen(issue)} />
      {issue.milestone || labels.length > 0 ? (
        <div className="mt-1 flex min-w-0 items-center gap-2 text-secondary-label">
          {issue.milestone ? (
            <span className="flex min-w-0 items-center gap-1">
              <MilestoneIcon aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{issue.milestone.title}</span>
            </span>
          ) : null}
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
        </div>
      ) : null}
      <div className="relative z-10 mt-2 flex">
        <Button size="xs" variant="outline" onClick={() => props.onStart(issue)}>
          <PlayIcon aria-hidden />
          Start feature
        </Button>
      </div>
    </div>
  );
});
