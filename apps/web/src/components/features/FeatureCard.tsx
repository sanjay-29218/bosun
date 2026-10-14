import {
  ordinal,
  stageLabel,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { GitBranchIcon } from "lucide-react";
import { memo, type DragEvent, type MouseEvent } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { cn } from "../../lib/utils";
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
  return (
    <button
      type="button"
      draggable={props.draggable}
      onDragStart={props.onDragStart ? (event) => props.onDragStart!(card, event) : undefined}
      onClick={() => props.onOpen(card)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onMenu(card, event);
      }}
      className={cn(
        // Off-screen cards skip layout and paint, like sidebar rows.
        "flex w-full min-w-0 cursor-default gap-1 rounded-lg border border-border bg-card text-left text-xs outline-hidden ring-ring [contain-intrinsic-size:auto_92px] [content-visibility:auto] hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset",
        layout === "card" ? "flex-col p-2.5" : "items-center gap-3 px-3 py-2",
      )}
    >
      <span
        className={cn("flex min-w-0 items-center gap-1.5", layout === "row" && "w-40 shrink-0")}
      >
        {project ? <ProjectFavicon project={project} className="size-3.5 shrink-0" /> : null}
        <span className="truncate text-muted-foreground">{project?.title ?? "Project"}</span>
        <span className={cn("ms-auto shrink-0 font-medium", status.className)}>
          {status.label}
          {waiting ? (
            <span className="ms-1 font-normal text-muted-foreground">{waiting}</span>
          ) : null}
        </span>
      </span>
      <span
        className={cn(
          "min-w-0 font-medium text-foreground text-sm",
          layout === "card" ? "line-clamp-2" : "flex-1 truncate",
        )}
      >
        {card.title}
      </span>
      <span
        className={cn(
          "flex min-w-0 items-center gap-1.5 text-muted-foreground",
          layout === "row" && "w-56 shrink-0",
        )}
      >
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
      {layout === "card" && card.detail && WAITING_STATES.has(card.state) ? (
        <span className="line-clamp-2 min-w-0 text-muted-foreground">{card.detail}</span>
      ) : null}
      {pullRequest !== null ? (
        <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
          <PullRequestGlyph.pullRequest aria-hidden className="size-3.5 shrink-0" />#
          {pullRequest.number}
        </span>
      ) : shell?.branch ? (
        <span
          className={cn(
            "flex min-w-0 items-center gap-1 text-muted-foreground",
            layout === "row" && "w-48 shrink-0",
          )}
        >
          <GitBranchIcon aria-hidden className="size-3.5 shrink-0" />
          <MiddleTruncate value={shell.branch} />
        </span>
      ) : null}
    </button>
  );
});
