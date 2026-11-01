import {
  FEATURE_CARD_ACTION_LABELS,
  featureCardQuickActions,
  featureRef,
  stageLabel,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import { issueRef, type EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import {
  resolveThreadWorkingStartedAt,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { CircleIcon, GitBranchIcon, MessageSquareIcon, PlayIcon } from "lucide-react";
import { memo, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { ProjectFavicon } from "../ProjectFavicon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { ThreadProviderStack } from "../sidebar/SidebarThreadRow";
import { MiddleTruncate } from "../ui/middle-truncate";
import type { FeatureBoardHandlers } from "./FeatureBoards";
import {
  ChatParkControls,
  FeatureParkControls,
  RelativeTime,
  chatSince,
  chatStatus,
  chatTitle,
  WAITING_STATES,
  WorkingDuration,
  featureStatus,
  type FeatureShelf,
} from "./FeatureCard";

/** A long stack shows its first page, then a button for the rest. */
export function Paged<T>(props: {
  readonly items: ReadonlyArray<T>;
  readonly pageSize: number | null;
  readonly render: (item: T) => ReactNode;
  readonly more?: (button: ReactNode) => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible =
    props.pageSize !== null && !expanded ? props.items.slice(0, props.pageSize) : props.items;
  const hidden = props.items.length - visible.length;
  const button =
    hidden > 0 ? (
      <Button variant="ghost-muted" size="xs" onClick={() => setExpanded(true)}>
        Show {hidden} more
      </Button>
    ) : null;
  return (
    <>
      {visible.map(props.render)}
      {button && props.more ? props.more(button) : button}
    </>
  );
}

const rowClassName =
  // Off-screen rows skip layout and paint, like sidebar rows.
  "group/card relative flex h-9 min-w-0 items-center gap-2.5 border-b border-border/50 px-3 text-sm [contain-intrinsic-size:auto_36px] [content-visibility:auto] hover:bg-accent/40 has-[[data-card-open]:focus-visible]:bg-accent/60";

/** Shown on hover or keyboard focus, and always on touch screens. */
const hoverOnlyClassName =
  "hidden group-hover/card:flex group-has-[:focus-visible]/card:flex pointer-coarse:flex";

/** The title, stretched over the whole row so a click anywhere opens it. */
function RowTitle(props: { readonly title: string; readonly onOpen: () => void }) {
  return (
    <button
      type="button"
      data-card-open
      onClick={props.onOpen}
      className="min-w-0 shrink cursor-default truncate text-left text-foreground outline-none after:absolute after:inset-0"
    >
      {props.title}
    </button>
  );
}

function RowId(props: { readonly children: ReactNode }) {
  return (
    <span className="w-12 shrink-0 truncate text-xs text-muted-foreground tabular-nums">
      {props.children}
    </span>
  );
}

function RowProject(props: { readonly project: EnvironmentProject | null }) {
  return (
    <span className="hidden w-28 shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:flex">
      {props.project ? (
        <ProjectFavicon project={props.project} className="size-3.5 shrink-0" />
      ) : null}
      <span className="truncate">{props.project?.title ?? "Project"}</span>
    </span>
  );
}

function Chip(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <span
      className={cn(
        "flex h-5 shrink-0 items-center gap-1 rounded-full border border-border/70 px-2 text-xs text-muted-foreground",
        props.className,
      )}
    >
      {props.children}
    </span>
  );
}

/** What the row says after its title: the question or failure, else its stage or state. */
function featureSubtitle(card: EnvironmentFeatureCard, statusLabel: string): string | null {
  if (card.detail && WAITING_STATES.has(card.state)) return card.detail;
  if (card.state === "working" && card.stage) return stageLabel(card.stage.stepId);
  if (card.state === "done") return null;
  return statusLabel;
}

export const FeatureRow = memo(function FeatureRow(props: {
  readonly card: EnvironmentFeatureCard;
  readonly handlers: FeatureBoardHandlers;
  readonly queuePosition: number | undefined;
  readonly shelf: FeatureShelf;
}) {
  const { card, handlers } = props;
  // Each row follows only its own stage thread, so a streaming stage repaints one row.
  const shell = useThreadShell(
    card.threadId ? scopeThreadRef(card.environmentId, card.threadId) : null,
  );
  const pullRequest = shell?.linkedPullRequest ?? shell?.branchPullRequest ?? null;
  const status = featureStatus(card, props.queuePosition);
  const StatusIcon = status.icon;
  const waiting = WAITING_STATES.has(card.state);
  const workingSince =
    card.state === "working" && !card.stage?.takenOver && shell
      ? resolveThreadWorkingStartedAt(shell)
      : null;
  const actions = featureCardQuickActions(card);
  const subtitle = featureSubtitle(card, status.label);
  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault();
        handlers.onMenu(card, event);
      }}
      className={cn(rowClassName, props.shelf !== null && "opacity-70 hover:opacity-100")}
    >
      <RowId>{featureRef(card)}</RowId>
      <StatusIcon aria-label={status.label} className={cn("size-4 shrink-0", status.className)} />
      <RowTitle title={card.title} onOpen={() => handlers.onOpen(card)} />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {subtitle ? `· ${subtitle}` : null}
      </span>
      {shell?.branch ? (
        <Chip className="hidden max-w-44 lg:flex">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={shell.branch} showTitle={false} />
        </Chip>
      ) : null}
      {pullRequest ? (
        <Chip className="tabular-nums">
          <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
          {pullRequest.number}
        </Chip>
      ) : null}
      {actions.length > 0 ? (
        <span className={cn("relative z-10 flex shrink-0 gap-1.5", !waiting && hoverOnlyClassName)}>
          {actions.map((action, index) => (
            <Button
              key={action}
              size="xs"
              variant={index === 0 && waiting ? "default" : "outline"}
              onClick={(event) => handlers.onAction(card, action, event)}
            >
              {action === "start" ? <PlayIcon aria-hidden /> : null}
              {FEATURE_CARD_ACTION_LABELS[action]}
            </Button>
          ))}
        </span>
      ) : null}
      <span className={cn("relative z-10 shrink-0", hoverOnlyClassName)}>
        <FeatureParkControls card={card} shelf={props.shelf} handlers={handlers} />
      </span>
      {shell ? <ThreadProviderStack thread={shell} /> : null}
      <RowProject project={handlers.projectFor(card)} />
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
        {workingSince ? (
          <span className="text-info-foreground">
            <WorkingDuration startedAt={workingSince} />
          </span>
        ) : (
          <RelativeTime timestamp={card.stateSince} />
        )}
      </span>
    </div>
  );
});

/** A chat thread outside any feature; its time shows where a feature's does. */
export const ChatRow = memo(function ChatRow(props: {
  readonly shell: EnvironmentThreadShell;
  readonly handlers: FeatureBoardHandlers;
  readonly shelf: FeatureShelf;
}) {
  const { shell, handlers } = props;
  const status = chatStatus(shell);
  const StatusIcon = status?.icon ?? MessageSquareIcon;
  const pullRequest = shell.linkedPullRequest ?? shell.branchPullRequest ?? null;
  const workingSince = status?.label === "Working" ? resolveThreadWorkingStartedAt(shell) : null;
  return (
    <div className={cn(rowClassName, props.shelf !== null && "opacity-70 hover:opacity-100")}>
      <RowId>
        <MessageSquareIcon aria-label="Thread" className="size-3.5" />
      </RowId>
      <StatusIcon
        aria-label={status?.label ?? "Thread"}
        className={cn("size-4 shrink-0", status?.className ?? "text-muted-foreground")}
      />
      <RowTitle title={chatTitle(shell)} onOpen={() => handlers.onOpenChat(shell)} />
      <span className="min-w-0 flex-1 truncate text-muted-foreground">
        {status && !workingSince ? `· ${status.label}` : null}
      </span>
      {shell.branch ? (
        <Chip className="hidden max-w-44 lg:flex">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <MiddleTruncate value={shell.branch} showTitle={false} />
        </Chip>
      ) : null}
      {pullRequest ? (
        <Chip className="tabular-nums">
          <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
          {pullRequest.number}
        </Chip>
      ) : null}
      <span className={cn("relative z-10 shrink-0", hoverOnlyClassName)}>
        <ChatParkControls shell={shell} shelf={props.shelf} handlers={handlers} />
      </span>
      <ThreadProviderStack thread={shell} />
      <RowProject project={handlers.projectFor(shell)} />
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
        {workingSince ? (
          <span className="text-info-foreground">
            <WorkingDuration startedAt={workingSince} />
          </span>
        ) : (
          <RelativeTime timestamp={chatSince(shell)} />
        )}
      </span>
    </div>
  );
});

/** An open issue or ticket no feature works on yet; Start feature shows on hover. */
export const TodoRow = memo(function TodoRow(props: {
  readonly issue: EnvironmentIssue;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { issue, handlers } = props;
  return (
    <div className={rowClassName}>
      <RowId>{issueRef(issue)}</RowId>
      <CircleIcon aria-label="Todo" className="size-4 shrink-0 text-muted-foreground" />
      <RowTitle title={issue.title} onOpen={() => handlers.onOpenTodo(issue)} />
      {/* Zero basis: the title takes its width first; labels that don't fit wrap out of sight. */}
      <span className="flex h-5 min-w-0 flex-1 flex-wrap justify-end gap-1.5 overflow-hidden">
        {issue.labels.slice(0, 2).map((label) => (
          <Chip key={label.name} className="hidden max-w-40 lg:flex">
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: `#${label.color}` }}
            />
            <span className="truncate">{label.name}</span>
          </Chip>
        ))}
      </span>
      <span className={cn("relative z-10 shrink-0", hoverOnlyClassName)}>
        <Button size="xs" variant="outline" onClick={() => handlers.onStartTodo(issue)}>
          <PlayIcon aria-hidden />
          Start feature
        </Button>
      </span>
      <RowProject project={handlers.projectFor(issue)} />
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground">
        <RelativeTime timestamp={issue.updatedAt} />
      </span>
    </div>
  );
});

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
