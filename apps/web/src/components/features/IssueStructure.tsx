import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  featureCardKey,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import type {
  EnvironmentIssue,
  EnvironmentMilestone,
} from "@t3tools/client-runtime/state/issue-board";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleIcon,
  CircleSlashIcon,
  CornerLeftUpIcon,
  ExternalLinkIcon,
  ListTreeIcon,
  MilestoneIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { FeatureBoardHandlers } from "./FeatureBoards";
import { featureStatus } from "./FeatureCard";

/** Where a feature's issue sits: its parent's number and its sub-issues' progress. */
export interface IssueStructureFacts {
  readonly url: string;
  readonly parent: number | null;
  readonly parentTitle: string | null;
  readonly subIssues: { readonly completed: number; readonly total: number } | null;
}

/**
 * A feature's issue as the board last read it, falling back to what the feature recorded when
 * it linked the issue. Tickets and tracker keys have no structure.
 */
export function featureIssueStructure(
  card: EnvironmentFeatureCard,
  handlers: Pick<FeatureBoardHandlers, "issueAt">,
): IssueStructureFacts | null {
  const issue = card.issue;
  if (!issue || issue.ticketId !== undefined || issue.key !== undefined || !issue.url) return null;
  const loaded = handlers.issueAt(card.environmentId, issue.url);
  const parent = loaded ? loaded.parent : (issue.parent ?? null);
  return {
    url: issue.url,
    parent,
    parentTitle:
      parent === null
        ? null
        : (handlers.issueAt(card.environmentId, issue.url, parent)?.title ?? null),
    subIssues: loaded ? loaded.subIssues : issue.subIssues,
  };
}

const chipClassName =
  "flex h-5 shrink-0 items-center gap-1 rounded-full border border-border/70 px-2 text-xs text-muted-foreground tabular-nums";

/** `↰ #48`: the issue this one is a part of, a chip on rows and plain on a card's meta line. */
export function PartOf(props: {
  readonly parent: number;
  readonly title: string | null;
  readonly variant?: "chip" | "inline";
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "relative z-10",
              props.variant === "inline"
                ? "flex shrink-0 items-center gap-1 tabular-nums"
                : chipClassName,
            )}
          />
        }
      >
        <CornerLeftUpIcon aria-label="Part of" className="size-3 shrink-0" />#{props.parent}
      </TooltipTrigger>
      <TooltipPopup>
        {props.title ? `Part of #${props.parent} · ${props.title}` : `Part of #${props.parent}`}
      </TooltipPopup>
    </Tooltip>
  );
}

export interface PartsFold {
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

/** A parent's `0/3` progress; when its parts sit under it, it folds them. */
export function PartsChip(props: {
  readonly subIssues: { readonly completed: number; readonly total: number };
  readonly fold?: PartsFold | undefined;
}) {
  const { subIssues, fold } = props;
  const progress = (
    <>
      <ListTreeIcon aria-hidden className="size-3 shrink-0" />
      {subIssues.completed}/{subIssues.total}
    </>
  );
  if (!fold) {
    return (
      <span aria-label="Sub-issues closed" className={chipClassName}>
        {progress}
      </span>
    );
  }
  const Chevron = fold.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <button
      type="button"
      aria-expanded={fold.expanded}
      aria-label={fold.expanded ? "Fold sub-issues" : "Show sub-issues"}
      onClick={fold.onToggle}
      className={cn(
        chipClassName,
        "relative z-10 cursor-pointer outline-none hover:border-border hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
      )}
    >
      {progress}
      <Chevron aria-hidden className="size-3 shrink-0" />
    </button>
  );
}

/**
 * A parent's row with its parts under it, open until folded. The fold is this group's own
 * state, so folding re-renders the group alone.
 */
export function PartsGroup(props: {
  readonly head: (fold: PartsFold) => ReactNode;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <>
      {props.head({ expanded, onToggle: () => setExpanded((open) => !open) })}
      {expanded ? props.children : null}
    </>
  );
}

const PARTS_SHOWN = 5;

/**
 * A parent card's loaded sub-issues under its details, like a parent feature's child features:
 * status, number, title and pull request. A part shown already as a child feature is left out.
 */
export function IssuePartList(props: {
  readonly parts: ReadonlyArray<EnvironmentIssue>;
  readonly handlers: FeatureBoardHandlers;
  /** Child features the card lists already. */
  readonly skip?: ReadonlyArray<EnvironmentFeatureCard>;
}) {
  const skip = new Set(props.skip?.map(featureCardKey));
  const parts = props.parts.flatMap((issue) => {
    const feature = props.handlers.featureFor(issue);
    return feature && skip.has(featureCardKey(feature)) ? [] : [{ issue, feature }];
  });
  if (parts.length === 0) return null;
  const hidden = parts.length - PARTS_SHOWN;
  return (
    <ul className="relative z-10 mt-2 flex flex-col gap-0.5 border-t border-border/60 pt-1.5">
      {parts.slice(0, PARTS_SHOWN).map(({ issue, feature }) => (
        <IssuePartLine key={issue.url} issue={issue} feature={feature} handlers={props.handlers} />
      ))}
      {hidden > 0 ? <li className="px-1 py-0.5 text-secondary-label">and {hidden} more</li> : null}
    </ul>
  );
}

function IssuePartLine(props: {
  readonly issue: EnvironmentIssue;
  readonly feature: EnvironmentFeatureCard | null;
  readonly handlers: FeatureBoardHandlers;
}) {
  const { issue, feature, handlers } = props;
  const lead = useThreadShell(
    feature?.leadThreadId ? scopeThreadRef(feature.environmentId, feature.leadThreadId) : null,
  );
  const pullRequest = lead?.linkedPullRequest ?? lead?.branchPullRequest ?? null;
  const status = feature
    ? featureStatus(feature, handlers.threadsFor(feature)).status
    : issue.state === "closed"
      ? { label: "Closed", className: "text-muted-foreground", icon: CircleSlashIcon }
      : { label: "Todo", className: "text-muted-foreground", icon: CircleIcon };
  const StatusIcon = status.icon;
  return (
    <li>
      <button
        type="button"
        onClick={() => (feature ? handlers.onOpen(feature) : handlers.onOpenTodo(issue))}
        className="flex w-full min-w-0 cursor-default items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-secondary-label outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <StatusIcon
          aria-label={status.label}
          className={cn("size-3.5 shrink-0", status.className)}
        />
        <span className="shrink-0 tabular-nums">#{issue.number}</span>
        <span className="min-w-0 flex-1 truncate">{issue.title}</span>
        {pullRequest ? (
          <span className="flex shrink-0 items-center gap-1 tabular-nums">
            <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
            {pullRequest.number}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** The milestone the board is narrowed to: its progress, due date and GitHub page. */
export function MilestoneHeader(props: { readonly milestone: EnvironmentMilestone }) {
  const { milestone } = props;
  const total = milestone.openIssues + milestone.closedIssues;
  const share = total === 0 ? 0 : Math.round((milestone.closedIssues / total) * 100);
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 rounded-lg border border-border/70 bg-muted/25 px-3 text-sm">
      <MilestoneIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate font-medium">{milestone.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {milestone.closedIssues} of {total} closed
      </span>
      <div
        role="progressbar"
        aria-label={`${milestone.title} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={share}
        className="hidden h-1 w-30 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
      >
        <div className="h-full bg-success" style={{ width: `${share}%` }} />
      </div>
      <span className="hidden shrink-0 text-xs text-muted-foreground md:inline">
        {milestone.dueOn
          ? `Due ${new Date(milestone.dueOn).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`
          : "No due date"}
      </span>
      <Button
        size="xs"
        variant="ghost-muted"
        className="ms-auto"
        onClick={() => void readLocalApi()?.shell.openExternal(milestone.url)}
      >
        <ExternalLinkIcon aria-hidden />
        GitHub
      </Button>
    </div>
  );
}
