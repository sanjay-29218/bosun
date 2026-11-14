import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentFeatureCard } from "@t3tools/client-runtime/state/crew-board";
import { issueKey, type EnvironmentIssue } from "@t3tools/client-runtime/state/issue-board";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  IssueDetail,
  IssueList,
  IssueStructureRef,
  RepositoryMilestone,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  CornerLeftUpIcon,
  MilestoneIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useQuietThreadShells, useThreadShell } from "../../state/entities";
import { FeatureIssueIcon } from "../crew/FeatureIssueIcon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { featureStatus } from "./FeatureCard";
import type { TodoOwner } from "./todoDialogs";

const chipClassName =
  "inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-border/70 px-2 text-xs text-muted-foreground";
const editableChipClassName = "cursor-pointer hover:border-border hover:text-foreground";
/** `+ Milestone`: an unset field this client can fill. */
const unsetChipClassName = cn(chipClassName, editableChipClassName, "border-dashed");

export interface StructureChange {
  /** Null clears it. */
  readonly milestone?: { readonly number: number; readonly title: string } | null;
  readonly parent?: number | null;
}

/** The milestone chip: a menu of the repository's open milestones, `+ Milestone` when unset. */
export function MilestoneChip(props: {
  readonly milestone: { readonly number: number; readonly title: string } | null;
  readonly milestones: ReadonlyArray<RepositoryMilestone>;
  readonly editable: boolean;
  /** A change is saving; another waits until it lands. */
  readonly busy: boolean;
  readonly onChange: (change: StructureChange) => void;
  readonly onShowOnBoard: () => void;
}) {
  const { milestone } = props;
  if (!props.editable) {
    return milestone ? (
      <span className={chipClassName}>
        <MilestoneIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{milestone.title}</span>
      </span>
    ) : null;
  }
  const choices =
    milestone && !props.milestones.some((choice) => choice.number === milestone.number)
      ? [{ ...milestone, openIssues: 0, closedIssues: 0, known: false }]
      : [];
  return (
    <Menu>
      <MenuTrigger
        disabled={props.busy}
        render={
          <button
            type="button"
            aria-label="Milestone"
            className={milestone ? cn(chipClassName, editableChipClassName) : unsetChipClassName}
          />
        }
      >
        {milestone ? (
          <>
            <MilestoneIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="truncate">{milestone.title}</span>
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </>
        ) : (
          <>
            <PlusIcon aria-hidden className="size-3.5 shrink-0" />
            Milestone
          </>
        )}
      </MenuTrigger>
      <MenuPopup align="start" className="w-72">
        <MenuGroupLabel>Milestone</MenuGroupLabel>
        <MenuRadioGroup
          value={milestone ? String(milestone.number) : ""}
          onValueChange={(value: string) => {
            if (value === (milestone ? String(milestone.number) : "")) return;
            const choice = [...props.milestones, ...choices].find(
              (candidate) => String(candidate.number) === value,
            );
            props.onChange({
              milestone: choice ? { number: choice.number, title: choice.title } : null,
            });
          }}
        >
          {[...choices, ...props.milestones].map((choice) => (
            <MenuRadioItem key={choice.number} value={String(choice.number)} closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{choice.title}</span>
                {"known" in choice ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {choice.closedIssues}/{choice.openIssues + choice.closedIssues}
                  </span>
                )}
              </span>
            </MenuRadioItem>
          ))}
          <MenuRadioItem value="" closeOnClick>
            <span className="text-muted-foreground">No milestone</span>
          </MenuRadioItem>
        </MenuRadioGroup>
        {milestone ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={props.onShowOnBoard}>
              <MilestoneIcon aria-hidden />
              Show on the board
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Open issues an issue could go under: not itself, and not one of its own sub-issues. */
export function parentChoices(
  issues: ReadonlyArray<IssueList["issues"][number]>,
  issue: Pick<IssueDetail, "number"> & {
    readonly subIssueList?: ReadonlyArray<IssueStructureRef> | null | undefined;
  },
) {
  const parts = new Set(issue.subIssueList?.map((part) => part.number));
  return issues.filter(
    (candidate) =>
      candidate.state === "open" &&
      candidate.number !== issue.number &&
      candidate.parent !== issue.number &&
      !parts.has(candidate.number),
  );
}

const PICKER_LIMIT = 50;

/** A searchable list of issues, matched by `#number` or title words. */
export function IssuePicker(props: {
  readonly choices: ReadonlyArray<IssueList["issues"][number]>;
  readonly checked: number | null;
  readonly onPick: (issue: IssueList["issues"][number]) => void;
}) {
  const [query, setQuery] = useState("");
  const words = query.trim().toLowerCase().replace(/^#/u, "").split(/\s+/u).filter(Boolean);
  const matches = props.choices
    .filter((choice) => {
      const haystack = `${choice.number} ${choice.title}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .slice(0, PICKER_LIMIT);
  return (
    <>
      <MenuSearchInput
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Find an issue by # or title"
        aria-label="Find an issue by # or title"
      />
      <MenuRadioGroup
        value={props.checked === null ? "" : String(props.checked)}
        onValueChange={(value: string) => {
          const choice = matches.find((candidate) => String(candidate.number) === value);
          if (choice && choice.number !== props.checked) props.onPick(choice);
        }}
      >
        {matches.map((choice) => (
          <MenuRadioItem key={choice.number} value={String(choice.number)} closeOnClick>
            <span className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 text-muted-foreground tabular-nums">#{choice.number}</span>
              <span className="min-w-0 flex-1 truncate">{choice.title}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {matches.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">
          <SearchIcon aria-hidden className="me-1.5 inline size-3.5" />
          No open issue matches
        </p>
      ) : null}
    </>
  );
}

/**
 * `↰ Part of #48`, split in two: the body opens the parent, the chevron changes it. `+ Parent`
 * when unset; read-only clients see the link alone.
 */
export function ParentChip(props: {
  readonly parent: number | null;
  readonly parentTitle: string | null;
  readonly choices: ReadonlyArray<IssueList["issues"][number]>;
  readonly editable: boolean;
  /** A change is saving; another waits until it lands. */
  readonly busy: boolean;
  readonly onOpen: (number: number) => void;
  readonly onChange: (parent: IssueList["issues"][number] | null) => void;
}) {
  const { parent } = props;
  if (parent === null && !props.editable) return null;
  const picker = (
    <MenuPopup align="start" className="w-80">
      <IssuePicker choices={props.choices} checked={parent} onPick={props.onChange} />
      {parent !== null ? (
        <>
          <MenuSeparator />
          <MenuItem onClick={() => props.onChange(null)}>
            <XIcon aria-hidden />
            Remove parent
          </MenuItem>
        </>
      ) : null}
    </MenuPopup>
  );
  if (parent === null) {
    return (
      <Menu>
        <MenuTrigger
          disabled={props.busy}
          render={<button type="button" aria-label="Parent" className={unsetChipClassName} />}
        >
          <PlusIcon aria-hidden className="size-3.5 shrink-0" />
          Parent
        </MenuTrigger>
        {picker}
      </Menu>
    );
  }
  return (
    <span className={cn(chipClassName, "gap-0 px-0")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => props.onOpen(parent)}
              className="inline-flex h-full min-w-0 cursor-pointer items-center gap-1.5 rounded-s-full ps-2 pe-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            />
          }
        >
          <CornerLeftUpIcon aria-hidden className="size-3.5 shrink-0" />
          Part of
          <span className="font-medium text-foreground tabular-nums">#{parent}</span>
        </TooltipTrigger>
        <TooltipPopup>{props.parentTitle ?? `Open #${parent}`}</TooltipPopup>
      </Tooltip>
      {props.editable ? (
        <Menu>
          <MenuTrigger
            disabled={props.busy}
            render={
              <button
                type="button"
                aria-label="Change parent"
                className="inline-flex h-full cursor-pointer items-center rounded-e-full border-s border-border/70 ps-1 pe-1.5 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              />
            }
          >
            <ChevronDownIcon aria-hidden className="size-3 shrink-0" />
          </MenuTrigger>
          {picker}
        </Menu>
      ) : null}
    </span>
  );
}

/**
 * A parent's sub-issues, under its description where GitHub puts them: progress, then a row per
 * part with the feature working on it and that feature's pull request.
 */
export function SubIssuesSection(props: {
  readonly owner: TodoOwner;
  readonly issue: IssueDetail;
  /** A re-read is in flight. */
  readonly refreshing: boolean;
  readonly onRetry: () => void;
  readonly loaded: ReadonlyArray<IssueList["issues"][number]>;
  readonly choices: ReadonlyArray<IssueList["issues"][number]>;
  readonly editable: boolean;
  readonly featureFor: (row: EnvironmentIssue) => EnvironmentFeatureCard | null;
  readonly onOpen: (number: number) => void;
  readonly onStart: (row: EnvironmentIssue) => void;
  readonly onAddExisting: (issue: IssueList["issues"][number]) => void;
  readonly onNew: () => void;
}) {
  const { issue } = props;
  const list = issue.subIssueList;
  const shells = useQuietThreadShells();
  // An older server sends no list; an issue with no parts gets no section.
  if (list === undefined || ((list === null || list.length === 0) && issue.subIssues === null)) {
    return null;
  }
  const closed =
    issue.subIssues?.completed ?? list?.filter((part) => part.state === "closed").length ?? 0;
  const total = issue.subIssues?.total ?? list?.length ?? 0;
  const share = total === 0 ? 0 : Math.round((closed / total) * 100);
  const loadedByNumber = new Map(props.loaded.map((loaded) => [loaded.number, loaded]));
  const rowFor = (part: IssueStructureRef): EnvironmentIssue => ({
    updatedAt: "",
    closedAt: null,
    milestone: null,
    subIssues: null,
    labels: [],
    assignees: [],
    ...loadedByNumber.get(part.number),
    ...part,
    parent: issue.number,
    ...props.owner,
    ticketId: null,
  });
  let body: ReactNode;
  if (props.refreshing) {
    body = [0, 1, 2].map((index) => (
      <div key={index} className="flex h-8.5 items-center gap-2 border-t border-border/60 px-3">
        <Skeleton shape="pill" className="size-3.5" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    ));
  } else if (list === null) {
    body = (
      <div className="flex h-8.5 items-center gap-2 border-t border-border/60 px-3 text-xs text-destructive-foreground">
        <AlertCircleIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Couldn't read the sub-issues from GitHub.</span>
        <Button size="xs" variant="ghost-muted" onClick={props.onRetry}>
          <RefreshCwIcon aria-hidden />
          Retry
        </Button>
      </div>
    );
  } else {
    body = list.map((part) => {
      const row = rowFor(part);
      return (
        <SubIssueRow
          key={issueKey(row)}
          row={row}
          feature={props.featureFor(row)}
          shells={shells}
          onOpen={() => props.onOpen(part.number)}
          onStart={() => props.onStart(row)}
        />
      );
    });
  }
  return (
    <section className="mt-1 flex flex-col overflow-hidden rounded-lg border border-border/70">
      <header className="flex h-9 items-center gap-2 ps-3 pe-1.5">
        <h3 className="text-sm font-medium">Sub-issues</h3>
        <span className="text-xs text-muted-foreground tabular-nums">
          {closed} of {total} closed
        </span>
        <div
          role="progressbar"
          aria-label="Sub-issues closed"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share}
          className="h-1 w-20 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-success" style={{ width: `${share}%` }} />
        </div>
        {props.editable ? (
          <Menu>
            <MenuTrigger render={<Button size="xs" variant="ghost-muted" className="ms-auto" />}>
              <PlusIcon aria-hidden />
              Add
              <ChevronDownIcon aria-hidden />
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuSub>
                <MenuSubTrigger>
                  <SearchIcon aria-hidden />
                  Add an existing issue…
                </MenuSubTrigger>
                <MenuSubPopup className="w-80">
                  <IssuePicker
                    choices={props.choices}
                    checked={null}
                    onPick={props.onAddExisting}
                  />
                </MenuSubPopup>
              </MenuSub>
              <MenuItem onClick={props.onNew}>
                <PlusIcon aria-hidden />
                New sub-issue…
              </MenuItem>
            </MenuPopup>
          </Menu>
        ) : null}
      </header>
      {body}
    </section>
  );
}

/** One sub-issue: its state, number and title, then its feature's status and pull request. */
function SubIssueRow(props: {
  readonly row: EnvironmentIssue;
  readonly feature: EnvironmentFeatureCard | null;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly onOpen: () => void;
  readonly onStart: () => void;
}) {
  const { row, feature } = props;
  const lead = useThreadShell(
    feature?.leadThreadId ? scopeThreadRef(feature.environmentId, feature.leadThreadId) : null,
  );
  const pullRequest = lead?.linkedPullRequest ?? lead?.branchPullRequest ?? null;
  const status = feature
    ? featureStatus(
        feature,
        props.shells.filter(
          (shell) =>
            shell.environmentId === feature.environmentId &&
            shell.feature?.id === feature.featureId,
        ),
      ).status
    : null;
  const StatusIcon = status?.icon;
  return (
    <div className="group/part relative flex h-8.5 min-w-0 items-center gap-2 border-t border-border/60 px-3 text-sm hover:bg-accent/40">
      <FeatureIssueIcon issue={row} className="size-3.5" />
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left outline-none after:absolute after:inset-0 focus-visible:underline"
      >
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">#{row.number}</span>
        <span className="min-w-0 truncate">{row.title}</span>
      </button>
      {status && StatusIcon ? (
        <span className={cn(chipClassName, "h-5 shrink-0")}>
          <StatusIcon aria-hidden className={cn("size-3 shrink-0", status.className)} />
          <span className="text-foreground">{status.label}</span>
          {pullRequest ? (
            <span className="flex items-center gap-0.5 tabular-nums">
              <PullRequestGlyph.pullRequest aria-hidden className="size-3" />
              {pullRequest.number}
            </span>
          ) : null}
        </span>
      ) : row.state === "open" ? (
        <Button
          size="xs"
          variant="outline"
          className="relative z-10 hidden group-hover/part:inline-flex group-has-[:focus-visible]/part:inline-flex pointer-coarse:inline-flex"
          onClick={props.onStart}
        >
          <PlayIcon aria-hidden />
          Start feature
        </Button>
      ) : null}
    </div>
  );
}

/** Opens the board narrowed to a milestone. */
export function useShowMilestoneOnBoard() {
  const navigate = useNavigate();
  return (owner: TodoOwner, milestone: number) =>
    void navigate({
      to: "/board",
      search: { milestone: issueKey({ ...owner, number: milestone }) },
    });
}
