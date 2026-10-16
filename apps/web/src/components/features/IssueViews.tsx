import type { EnvironmentFeatureCard } from "@t3tools/client-runtime/state/crew-board";
import {
  ISSUE_LANE_LABELS,
  issueKey,
  milestoneKey,
  milestoneProgress,
  type EnvironmentIssue,
  type EnvironmentMilestone,
  type IssueGroup,
  type IssueLane,
} from "@t3tools/client-runtime/state/issue-board";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ChevronRightIcon, ExternalLinkIcon, ListTreeIcon, PlayIcon } from "lucide-react";
import { memo, useState, type MouseEvent } from "react";

import { cn } from "../../lib/utils";
import { formatRelativeTime } from "../../timestampFormat";
import { FeatureIssueIcon } from "../crew/FeatureIssue";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { featureOwnerLine, featureStatus } from "./FeatureCard";
import type { IssueDisplayPreferences } from "./featuresPagePreferences";
import { PhaseIcon } from "./PhaseIcon";

export const LANE_PROGRESS: Record<IssueLane, number | "done"> = {
  todo: 0,
  "in-crew": 0.5,
  "in-review": 0.75,
  done: "done",
};

export interface IssueViewHandlers {
  readonly projectFor: (owner: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => EnvironmentProject | null;
  readonly featureFor: (issue: EnvironmentIssue) => EnvironmentFeatureCard | null;
  readonly laneFor: (issue: EnvironmentIssue) => IssueLane;
  readonly onOpenIssue: (issue: EnvironmentIssue) => void;
  readonly onOpenFeature: (card: EnvironmentFeatureCard) => void;
  readonly onStartFeature: (issue: EnvironmentIssue) => void;
  /** Rows name their project when more than one is shown. */
  readonly showProject: boolean;
  readonly display: IssueDisplayPreferences;
}

const dueLabel = (dueOn: string) =>
  new Date(dueOn).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The crew's feature on an issue, or a Start button for an open issue without one. */
function IssueFeatureCell(props: {
  readonly issue: EnvironmentIssue;
  readonly feature: EnvironmentFeatureCard | null;
  readonly handlers: IssueViewHandlers;
}) {
  const { feature, issue } = props;
  if (feature) {
    const status = featureStatus(feature, undefined);
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                props.handlers.onOpenFeature(feature);
              }}
              className="inline-flex h-5 min-w-0 max-w-48 items-center gap-1.5 rounded-md border border-border/70 px-1.5 text-2xs text-muted-foreground hover:border-border hover:text-foreground"
            />
          }
        >
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full bg-current", status.className)}
          />
          <span className="truncate">{featureOwnerLine(feature)}</span>
        </TooltipTrigger>
        <TooltipPopup>
          {feature.title} · {status.label}
        </TooltipPopup>
      </Tooltip>
    );
  }
  if (issue.state === "closed") return null;
  return (
    // Shown on row hover and focus, so a list of a hundred issues is not a hundred buttons.
    <span className="flex opacity-0 group-hover/issue:opacity-100 group-focus-within/issue:opacity-100">
      <Button
        size="xs"
        variant="ghost-muted"
        onClick={(event: MouseEvent) => {
          event.stopPropagation();
          props.handlers.onStartFeature(issue);
        }}
      >
        <PlayIcon aria-hidden />
        Start feature
      </Button>
    </span>
  );
}

function IssueLabels(props: { readonly issue: EnvironmentIssue; readonly limit: number }) {
  const shown = props.issue.labels.slice(0, props.limit);
  const hidden = props.issue.labels.length - shown.length;
  return (
    <>
      {shown.map((label) => (
        <span
          key={label.name}
          className="inline-flex h-5 min-w-0 max-w-28 shrink-0 items-center gap-1 rounded-full border border-border/70 px-1.5 text-2xs text-muted-foreground"
        >
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: `#${label.color}` }}
          />
          <span className="truncate">{label.name}</span>
        </span>
      ))}
      {hidden > 0 ? (
        <span className="shrink-0 text-2xs text-muted-foreground">+{hidden}</span>
      ) : null}
    </>
  );
}

function IssueAssignees(props: { readonly issue: EnvironmentIssue }) {
  if (props.issue.assignees.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 -space-x-1.5" />}>
        {props.issue.assignees.slice(0, 3).map((assignee) => (
          <img
            key={assignee.login}
            src={assignee.avatarUrl}
            alt={assignee.login}
            loading="lazy"
            className="size-5 rounded-full border border-background bg-muted"
          />
        ))}
      </TooltipTrigger>
      <TooltipPopup>
        {props.issue.assignees.map((assignee) => assignee.login).join(", ")}
      </TooltipPopup>
    </Tooltip>
  );
}

function SubIssueCount(props: { readonly issue: EnvironmentIssue }) {
  const { subIssues } = props.issue;
  if (!subIssues) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums" />
        }
      >
        <ListTreeIcon aria-hidden className="size-3" />
        {subIssues.completed}/{subIssues.total}
      </TooltipTrigger>
      <TooltipPopup>
        {subIssues.completed} of {subIssues.total} sub-issues closed
      </TooltipPopup>
    </Tooltip>
  );
}

/** One issue as a list row, in the dense single-line style Linear lists use. */
export const IssueRow = memo(function IssueRow(props: {
  readonly issue: EnvironmentIssue;
  readonly depth: 0 | 1;
  readonly showMilestone: boolean;
  readonly handlers: IssueViewHandlers;
}) {
  const { issue, handlers } = props;
  const feature = handlers.featureFor(issue);
  const project = handlers.showProject ? handlers.projectFor(issue) : null;
  const updated = formatRelativeTime(issue.updatedAt)?.value ?? null;
  const lane = handlers.laneFor(issue);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => (feature ? handlers.onOpenFeature(feature) : handlers.onOpenIssue(issue))}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (feature) handlers.onOpenFeature(feature);
        else handlers.onOpenIssue(issue);
      }}
      className={cn(
        // Off-screen rows skip layout and paint, like sidebar rows.
        "group/issue flex h-9 min-w-0 cursor-default items-center gap-2 border-b border-border/50 pe-3 text-sm outline-hidden ring-ring [contain-intrinsic-size:auto_36px] [content-visibility:auto] last:border-b-0 hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset",
        props.depth === 1 ? "ps-9" : "ps-3",
      )}
    >
      {props.depth === 1 ? (
        <span aria-hidden className="-ms-4 h-full w-3 shrink-0 border-s border-border/70" />
      ) : null}
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <PhaseIcon progress={LANE_PROGRESS[lane]} />
        </TooltipTrigger>
        <TooltipPopup>{ISSUE_LANE_LABELS[lane]}</TooltipPopup>
      </Tooltip>
      <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
        #{issue.number}
      </span>
      {project ? (
        <span className="flex max-w-32 shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <ProjectFavicon project={project} className="size-3.5 shrink-0" />
          <span className="truncate">{project.title}</span>
        </span>
      ) : null}
      <span
        className={cn(
          "min-w-0 truncate",
          issue.state === "closed" ? "text-muted-foreground" : "text-foreground",
        )}
      >
        {issue.title}
      </span>
      <SubIssueCount issue={issue} />
      <span className="ms-auto flex min-w-0 shrink items-center justify-end gap-1.5">
        {handlers.display.labels ? <IssueLabels issue={issue} limit={2} /> : null}
        {props.showMilestone && issue.milestone ? (
          <span className="hidden max-w-32 shrink-0 truncate text-2xs text-muted-foreground lg:inline">
            {issue.milestone.title}
          </span>
        ) : null}
        <IssueFeatureCell issue={issue} feature={feature} handlers={handlers} />
      </span>
      {handlers.display.assignees ? <IssueAssignees issue={issue} /> : null}
      <span className="w-10 shrink-0 text-end text-xs text-muted-foreground tabular-nums">
        {updated}
      </span>
      <button
        type="button"
        aria-label={`Open #${issue.number} on GitHub`}
        onClick={(event) => {
          event.stopPropagation();
          handlers.onOpenIssue(issue);
        }}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover/issue:opacity-100 group-focus-within/issue:opacity-100"
      >
        <ExternalLinkIcon aria-hidden className="size-3.5" />
      </button>
    </div>
  );
});

/** A thin closed-share bar; static, so it costs nothing while the page sits open. */
function ProgressBar(props: { readonly value: number; readonly className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted", props.className)}
    >
      <span
        className="block h-full rounded-full bg-primary"
        style={{ width: `${Math.round(props.value * 100)}%` }}
      />
    </span>
  );
}

function GroupHeader(props: {
  readonly group: IssueGroup;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  const { group } = props;
  const progress = group.milestone ? milestoneProgress(group.milestone) : null;
  return (
    <button
      type="button"
      aria-expanded={!props.collapsed}
      onClick={props.onToggle}
      className="flex h-9 w-full min-w-0 items-center gap-2 border-b border-border/60 bg-muted/40 px-3 text-left text-sm hover:bg-muted/60"
    >
      <ChevronRightIcon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !props.collapsed && "rotate-90",
        )}
      />
      {group.lane ? <PhaseIcon progress={LANE_PROGRESS[group.lane]} /> : null}
      {progress !== null ? <PhaseIcon progress={progress >= 1 ? "done" : progress} /> : null}
      <span className="truncate font-medium">{group.title}</span>
      <span className="shrink-0 text-muted-foreground tabular-nums">{group.count}</span>
      {group.milestone ? (
        <span className="ms-auto flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {group.milestone.dueOn ? <span>Due {dueLabel(group.milestone.dueOn)}</span> : null}
          <ProgressBar value={progress ?? 0} />
          <span className="w-8 text-end tabular-nums">{Math.round((progress ?? 0) * 100)}%</span>
        </span>
      ) : null}
    </button>
  );
}

/** Issues as grouped rows. Groups fold, and remember it while the page is open. */
export function IssueListView(props: {
  readonly groups: ReadonlyArray<IssueGroup>;
  readonly handlers: IssueViewHandlers;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const showGroupHeaders = props.handlers.display.groupBy !== "none";
  const showMilestone = props.handlers.display.groupBy !== "milestone";
  return (
    <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
      {props.groups.map((group) => {
        if (group.count === 0 && group.lane === null) return null;
        const isCollapsed = collapsed.has(group.key);
        return (
          <section key={group.key}>
            {showGroupHeaders ? (
              <GroupHeader
                group={group}
                collapsed={isCollapsed}
                onToggle={() =>
                  setCollapsed((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })
                }
              />
            ) : null}
            {isCollapsed
              ? null
              : group.rows.map((row) => (
                  <IssueRow
                    key={issueKey(row.issue)}
                    issue={row.issue}
                    depth={row.depth}
                    showMilestone={showMilestone}
                    handlers={props.handlers}
                  />
                ))}
            {!isCollapsed && group.count === 0 ? (
              <p className="border-b border-border/50 px-9 py-2 text-xs text-muted-foreground/70">
                No issues
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

const IssueCard = memo(function IssueCard(props: {
  readonly issue: EnvironmentIssue;
  readonly handlers: IssueViewHandlers;
}) {
  const { issue, handlers } = props;
  const feature = handlers.featureFor(issue);
  const project = handlers.showProject ? handlers.projectFor(issue) : null;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => (feature ? handlers.onOpenFeature(feature) : handlers.onOpenIssue(issue))}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (feature) handlers.onOpenFeature(feature);
        else handlers.onOpenIssue(issue);
      }}
      className="group/issue flex w-full min-w-0 cursor-default flex-col gap-2 rounded-lg border border-border/70 bg-card px-3 py-2.5 text-left text-xs shadow-xs/5 outline-hidden ring-ring [contain-intrinsic-size:auto_96px] [content-visibility:auto] hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <FeatureIssueIcon issue={issue} className="size-3" />
        <span className="shrink-0 tabular-nums">#{issue.number}</span>
        {project ? <span className="truncate">· {project.title}</span> : null}
        {issue.milestone ? (
          <span className="ms-auto max-w-32 shrink-0 truncate">{issue.milestone.title}</span>
        ) : null}
      </span>
      <span className="line-clamp-2 min-w-0 text-sm font-medium leading-snug text-foreground">
        {issue.title}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        <SubIssueCount issue={issue} />
        {handlers.display.labels ? <IssueLabels issue={issue} limit={3} /> : null}
        <span className="ms-auto flex items-center gap-1.5">
          <IssueFeatureCell issue={issue} feature={feature} handlers={handlers} />
          {handlers.display.assignees ? <IssueAssignees issue={issue} /> : null}
        </span>
      </span>
    </div>
  );
});

/** Done keeps its newest few visible, like the features board. */
const DONE_PAGE = 10;

/** Issues as status lanes: Todo, In crew, In review, Done. */
export function IssueBoardView(props: {
  readonly groups: ReadonlyArray<IssueGroup>;
  readonly handlers: IssueViewHandlers;
}) {
  const [doneExpanded, setDoneExpanded] = useState(false);
  return (
    <div className="grid min-h-0 flex-1 auto-cols-[minmax(17rem,1fr)] grid-flow-col gap-2 overflow-x-auto pb-2">
      {props.groups.map((group) => {
        const issues = group.rows.map((row) => row.issue);
        const paged = group.lane === "done" && !doneExpanded;
        const visible = paged ? issues.slice(0, DONE_PAGE) : issues;
        return (
          <section
            key={group.key}
            className="flex h-full min-h-[calc(100dvh-11rem)] min-w-0 flex-col gap-1.5 rounded-xl bg-muted/25 p-1.5"
          >
            <header className="flex h-8 items-center gap-2 px-1.5 text-sm font-medium">
              {group.lane ? <PhaseIcon progress={LANE_PROGRESS[group.lane]} /> : null}
              {group.title}
              <span className="font-normal text-muted-foreground tabular-nums">{group.count}</span>
            </header>
            {visible.length === 0 ? (
              <p className="flex flex-1 items-center justify-center px-2 text-xs text-muted-foreground/70">
                No issues
              </p>
            ) : (
              visible.map((issue) => (
                <IssueCard key={issueKey(issue)} issue={issue} handlers={props.handlers} />
              ))
            )}
            {issues.length > visible.length ? (
              <Button variant="ghost" size="sm" onClick={() => setDoneExpanded(true)}>
                Show {issues.length - visible.length} more
              </Button>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** Open milestones as progress cards; opening one shows its issues. */
export function MilestonesView(props: {
  readonly milestones: ReadonlyArray<EnvironmentMilestone>;
  readonly issues: ReadonlyArray<EnvironmentIssue>;
  readonly handlers: IssueViewHandlers;
  readonly onOpenMilestone: (milestone: EnvironmentMilestone) => void;
}) {
  if (props.milestones.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No open milestones. Milestones made on GitHub show up here.
      </p>
    );
  }
  // How many of a milestone's issues the crew has picked up, from the issues read with it.
  const inCrew = new Map<string, number>();
  for (const issue of props.issues) {
    if (!issue.milestone || issue.state === "closed") continue;
    const lane = props.handlers.laneFor(issue);
    if (lane !== "in-crew" && lane !== "in-review") continue;
    const key = milestoneKey({ ...issue, number: issue.milestone.number });
    inCrew.set(key, (inCrew.get(key) ?? 0) + 1);
  }
  const sorted = props.milestones.toSorted(
    (left, right) =>
      (left.dueOn ?? "￿").localeCompare(right.dueOn ?? "￿") ||
      left.title.localeCompare(right.title),
  );
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-2">
      {sorted.map((milestone) => {
        const progress = milestoneProgress(milestone);
        const project = props.handlers.showProject ? props.handlers.projectFor(milestone) : null;
        const crewCount = inCrew.get(milestoneKey(milestone)) ?? 0;
        return (
          <button
            key={milestoneKey(milestone)}
            type="button"
            onClick={() => props.onOpenMilestone(milestone)}
            className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/70 bg-card p-3.5 text-left shadow-xs/5 outline-hidden ring-ring hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset"
          >
            <span className="flex min-w-0 items-center gap-2">
              <PhaseIcon progress={progress >= 1 ? "done" : progress} />
              <span className="truncate text-sm font-medium">{milestone.title}</span>
              {milestone.dueOn ? (
                <span className="ms-auto shrink-0 text-xs text-muted-foreground">
                  Due {dueLabel(milestone.dueOn)}
                </span>
              ) : null}
            </span>
            {project ? (
              <span className="-mt-2 flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
                <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                <span className="truncate">{project.title}</span>
              </span>
            ) : null}
            <span className="flex items-center gap-2">
              <ProgressBar value={progress} className="w-auto flex-1" />
              <span className="text-xs text-muted-foreground tabular-nums">
                {Math.round(progress * 100)}%
              </span>
            </span>
            <span className="flex gap-3 text-xs text-muted-foreground tabular-nums">
              <span>{milestone.openIssues} open</span>
              <span>{milestone.closedIssues} closed</span>
              {crewCount > 0 ? <span className="text-info">{crewCount} with the crew</span> : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Open issues no feature works on yet, offered from the empty Features board. */
export function IssueSuggestions(props: {
  readonly issues: ReadonlyArray<EnvironmentIssue>;
  readonly handlers: IssueViewHandlers;
  readonly onShowAll: () => void;
}) {
  if (props.issues.length === 0) return null;
  return (
    <div className="w-full max-w-xl text-left">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>Or start from an open issue</span>
        <Button size="xs" variant="ghost-muted" onClick={props.onShowAll}>
          All issues
        </Button>
      </div>
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
        {props.issues.map((issue) => (
          <div
            key={issueKey(issue)}
            className="flex h-10 min-w-0 items-center gap-2 border-b border-border/50 px-3 text-sm last:border-b-0"
          >
            <FeatureIssueIcon issue={issue} className="size-3.5" />
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              #{issue.number}
            </span>
            <button
              type="button"
              className="min-w-0 truncate text-left hover:underline"
              onClick={() => props.handlers.onOpenIssue(issue)}
            >
              {issue.title}
            </button>
            <span className="ms-auto flex">
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.handlers.onStartFeature(issue)}
              >
                <PlayIcon aria-hidden />
                Start
              </Button>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
