import {
  ordinal,
  stageLabel,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { GitBranchIcon } from "lucide-react";
import { memo, type ComponentProps, type DragEvent, type MouseEvent } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { cn } from "../../lib/utils";
import { featureIssueMeta, FeatureIssueIcon } from "../crew/FeatureIssue";
import { useThreadShell } from "../../state/entities";
import { formatRelativeTime } from "../../timestampFormat";
import { ProjectFavicon } from "../ProjectFavicon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Status words reuse the sidebar's hues (sky working, amber approval, indigo input, red
 * failed), so a feature reads the same on the board as its stage thread does in the sidebar.
 */
export function featureStatus(
  card: EnvironmentFeatureCard,
  queuePosition: number | undefined,
): { readonly label: string; readonly className: string } {
  if (!card.started && card.state !== "done" && card.state !== "cancelled")
    return { label: "Not started", className: "text-muted-foreground" };
  switch (card.state) {
    case "working":
      return card.stage?.takenOver
        ? { label: "Taken over", className: "text-warning-foreground" }
        : { label: "Working", className: "text-info" };
    case "queued":
      return {
        label: queuePosition ? `Queued · ${ordinal(queuePosition)}` : "Queued",
        className: "text-muted-foreground",
      };
    case "approval":
      return { label: "Approval", className: "text-warning-foreground" };
    case "input":
      return { label: "Input", className: "text-indigo-600 dark:text-indigo-300" };
    case "your-call":
      return { label: "Your call", className: "text-warning-foreground" };
    case "failed":
      return { label: "Failed", className: "text-error" };
    case "paused":
      return { label: "Paused", className: "text-muted-foreground" };
    case "cancelled":
      return { label: "Cancelled", className: "text-muted-foreground" };
    case "done":
      return { label: "Done", className: "text-success" };
  }
}

/** "waiting 12m", from when the feature entered its state. Static: it updates with the data. */
export function waitingLabel(since: string): string | null {
  const relative = formatRelativeTime(since);
  return relative ? relative.value : null;
}

/** "Designer · attempt 2", or what stopped a closed feature. */
export function featureOwnerLine(card: EnvironmentFeatureCard): string {
  if (!card.stage) return card.workflow.name;
  const stage = stageLabel(card.stage.stepId);
  if (card.state === "cancelled") return `Stopped at ${stage}`;
  if (card.state === "done") return card.workflow.name;
  const role = card.stage.takenOver ? "You" : stageLabel(card.stage.role);
  return card.stage.attempt > 1
    ? `${role} · ${stage} · attempt ${card.stage.attempt}`
    : `${role} · ${stage}`;
}

/** States where the card's detail says what you are waiting on. */
const WAITING_STATES = new Set<EnvironmentFeatureCard["state"]>([
  "approval",
  "input",
  "your-call",
  "failed",
]);

/** One property on a board card, in the bordered pill Linear-style boards use. */
function CardChip(props: ComponentProps<"span">) {
  return (
    <span
      {...props}
      className={cn(
        "inline-flex h-5 min-w-0 max-w-full items-center gap-1 rounded-md border border-border/70 px-1.5 text-2xs text-muted-foreground",
        props.className,
      )}
    />
  );
}

export const FeatureCard = memo(function FeatureCard(props: {
  readonly card: EnvironmentFeatureCard;
  readonly project: EnvironmentProject | null;
  readonly queuePosition: number | undefined;
  readonly layout: "card" | "row";
  readonly draggable: boolean;
  readonly onOpen: (card: EnvironmentFeatureCard) => void;
  readonly onMenu: (card: EnvironmentFeatureCard, event: MouseEvent) => void;
  readonly onDragStart?: (card: EnvironmentFeatureCard, event: DragEvent) => void;
}) {
  const { card, project, layout } = props;
  // Each card follows only its own stage thread, so a streaming stage repaints one card.
  const shell = useThreadShell(
    card.threadId ? scopeThreadRef(card.environmentId, card.threadId) : null,
  );
  const pullRequest = shell?.linkedPullRequest ?? shell?.branchPullRequest ?? null;
  const model = shell?.modelSelection.model ?? null;
  const status = featureStatus(card, props.queuePosition);
  const waiting =
    card.state === "working" || card.state === "done" || card.state === "cancelled"
      ? null
      : waitingLabel(card.stateSince);
  const outdated =
    card.workflow.latestRevision !== null && card.workflow.revision < card.workflow.latestRevision;
  const interaction = {
    type: "button" as const,
    draggable: props.draggable,
    onDragStart: props.onDragStart
      ? (event: DragEvent) => props.onDragStart!(card, event)
      : undefined,
    onClick: () => props.onOpen(card),
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      props.onMenu(card, event);
    },
  };
  if (layout === "card") {
    const issueMeta = card.issue ? featureIssueMeta(card.issue) : null;
    return (
      <button
        {...interaction}
        className={cn(
          // Off-screen cards skip layout and paint, like sidebar rows.
          "flex w-full min-w-0 cursor-default flex-col gap-2 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left text-xs shadow-xs/5 outline-hidden ring-ring [contain-intrinsic-size:auto_104px] [content-visibility:auto] hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
          <span className="truncate">{project?.title ?? "Project"}</span>
          {card.issue ? (
            <span className="flex shrink-0 items-center gap-1">
              <FeatureIssueIcon issue={card.issue} className="size-3" />#{card.issue.number}
            </span>
          ) : null}
          {waiting ? <span className="ms-auto shrink-0 tabular-nums">{waiting}</span> : null}
        </span>
        <span className="line-clamp-2 min-w-0 text-sm font-medium leading-snug text-foreground">
          {card.title}
        </span>
        {card.detail && WAITING_STATES.has(card.state) ? (
          <span className="line-clamp-2 min-w-0 text-muted-foreground">{card.detail}</span>
        ) : null}
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <CardChip>
            <span
              aria-hidden
              className={cn("size-1.5 rounded-full bg-current", status.className)}
            />
            <span className={status.className}>{status.label}</span>
          </CardChip>
          {card.stage && card.state !== "done" ? (
            <CardChip>
              <span className="truncate">{featureOwnerLine(card)}</span>
            </CardChip>
          ) : null}
          {pullRequest !== null ? (
            <CardChip>
              <PullRequestGlyph.pullRequest aria-hidden className="size-3 shrink-0" />#
              {pullRequest.number}
            </CardChip>
          ) : shell?.branch ? (
            <CardChip>
              <GitBranchIcon aria-hidden className="size-3 shrink-0" />
              <MiddleTruncate value={shell.branch} />
            </CardChip>
          ) : null}
          {issueMeta ? (
            <CardChip>
              <span className="truncate">{issueMeta}</span>
            </CardChip>
          ) : null}
          {model ? (
            <CardChip>
              <span className="truncate">{model}</span>
            </CardChip>
          ) : null}
          {outdated ? (
            <Tooltip>
              <TooltipTrigger render={<CardChip />}>v{card.workflow.revision}</TooltipTrigger>
              <TooltipPopup>
                Runs {card.workflow.name} version {card.workflow.revision}; the latest is{" "}
                {card.workflow.latestRevision}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </span>
      </button>
    );
  }
  return (
    <button
      {...interaction}
      className="flex w-full min-w-0 cursor-default items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left text-xs outline-hidden ring-ring [contain-intrinsic-size:auto_40px] [content-visibility:auto] hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="flex w-40 min-w-0 shrink-0 items-center gap-1.5">
        {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
        <span className="truncate text-muted-foreground">{project?.title ?? "Project"}</span>
        <span className={cn("ms-auto shrink-0 font-medium", status.className)}>
          {status.label}
          {waiting ? (
            <span className="ms-1 font-normal text-muted-foreground">{waiting}</span>
          ) : null}
        </span>
      </span>
      <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
        {card.title}
      </span>
      <span className="flex w-56 min-w-0 shrink-0 items-center gap-1.5 text-muted-foreground">
        <span className="truncate">{featureOwnerLine(card)}</span>
        {model ? <span className="shrink-0 truncate">· {model}</span> : null}
        {outdated ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <span className="ms-auto shrink-0 rounded border border-border px-1 text-3xs" />
              }
            >
              v{card.workflow.revision}
            </TooltipTrigger>
            <TooltipPopup>
              Runs {card.workflow.name} version {card.workflow.revision}; the latest is{" "}
              {card.workflow.latestRevision}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </span>
      {card.issue ? (
        <span className="flex w-40 min-w-0 shrink-0 items-center gap-1 text-muted-foreground">
          <FeatureIssueIcon issue={card.issue} className="size-3.5" />
          <span className="shrink-0">#{card.issue.number}</span>
          {featureIssueMeta(card.issue) ? (
            <span className="truncate">· {featureIssueMeta(card.issue)}</span>
          ) : null}
        </span>
      ) : null}
      {pullRequest !== null ? (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <PullRequestGlyph.pullRequest aria-hidden className="size-3.5 shrink-0" />#
          {pullRequest.number}
        </span>
      ) : shell?.branch ? (
        <span className="flex w-48 min-w-0 shrink-0 items-center gap-1 text-muted-foreground">
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <MiddleTruncate value={shell.branch} />
        </span>
      ) : null}
    </button>
  );
});
