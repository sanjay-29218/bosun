import { featureTagColor } from "@t3tools/client-runtime/feature-tag";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  childFeatureSummary,
  type WorkGroup,
  type WorkGroupEntry,
} from "@t3tools/client-runtime/state/work-groups";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { FINISHED_ROW_ICON_CLASS, FINISHED_ROW_TITLE_CLASS } from "../finishedRowClasses";
import { InlineButton } from "../ui/button";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

export type SidebarWorkGroup = WorkGroup<EnvironmentThreadShell>;

const STATUS_LABELS: Partial<Record<SidebarThreadStatus, string>> = {
  approval: "Approval",
  input: "Input",
  working: "Working",
  failed: "Failed",
};

const workColor = (group: SidebarWorkGroup) =>
  featureTagColor(group.primary.feature?.id ?? group.primary.crewRequest?.id ?? group.key);

/** The meta line of a feature or bot request row: its color and who has worked on it. */
export function SidebarWorkGroupSummary(props: { readonly group: SidebarWorkGroup }) {
  const { group } = props;
  // A feature's row is its lead, so its chain is the crew the lead handed work to.
  const chain =
    group.kind === "request"
      ? [group.primary, ...group.children.map((entry) => entry.thread)]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((thread) => thread.crewRequest?.member ?? thread.title)
      : group.children.map((entry) => entry.label);
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: workColor(group) }}
      />
      {chain.length > 0 ? (
        <span className="min-w-0 truncate text-muted-foreground">
          {chain.length > 3
            ? `${chain.slice(0, 2).join(" → ")} → +${chain.length - 2}`
            : chain.join(" → ")}
        </span>
      ) : null}
    </span>
  );
}

function StatusIcon({ status }: { readonly status: SidebarThreadStatus }) {
  switch (status) {
    case "working":
      return <CircleDashedIcon aria-hidden className="size-3.5 shrink-0 text-info-foreground" />;
    case "waiting":
      return <CircleDashedIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />;
    case "approval":
      return (
        <ShieldQuestionIcon aria-hidden className="size-3.5 shrink-0 text-warning-foreground" />
      );
    case "input":
      return (
        <MessageCircleQuestionIcon aria-hidden className="size-3.5 shrink-0 text-info-foreground" />
      );
    case "failed":
      return <CircleAlertIcon aria-hidden className="size-3.5 shrink-0 text-error-foreground" />;
    default:
      return <CircleCheckIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/60" />;
  }
}

/** The id of the list of child features under a row, for its chip's `aria-controls`. */
export const childFeatureListId = (rowKey: string) => `sidebar-child-features:${rowKey}`;

/**
 * A parent feature row's toggle for its child features: "2 children · 1 running", or just the
 * count where the row has no meta line.
 */
export function SidebarChildFeatureChip(props: {
  readonly group: SidebarWorkGroup;
  readonly rowKey: string;
  readonly expanded: boolean;
  readonly compact: boolean;
  readonly onToggle: (rowKey: string) => void;
}) {
  const summary = childFeatureSummary(props.group, isThreadWorking);
  const Icon = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  const noun = summary.total === 1 ? "child feature" : "child features";
  return (
    <InlineButton
      tone="muted"
      aria-expanded={props.expanded}
      aria-controls={childFeatureListId(props.rowKey)}
      aria-label={`${props.expanded ? "Hide" : "Show"} ${summary.total} ${noun} (${summary.label})`}
      onClick={(event) => {
        // The row behind the chip opens its thread; the chip only folds.
        event.preventDefault();
        event.stopPropagation();
        props.onToggle(props.rowKey);
      }}
    >
      <Icon aria-hidden className="size-3" />
      <span className="tabular-nums">{props.compact ? summary.compactLabel : summary.label}</span>
    </InlineButton>
  );
}

/** One of a group's other threads, listed under its row: a crew member, an attempt or a child. */
export const SidebarWorkGroupEntry = memo(function SidebarWorkGroupEntry(props: {
  readonly entry: WorkGroupEntry<EnvironmentThreadShell>;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
  /** A finished child feature, dimmed as Lineage dims it. */
  readonly finished?: boolean;
}) {
  const { thread, label } = props.entry;
  const status = resolveSidebarThreadStatus(thread);
  const statusLabel = STATUS_LABELS[status];
  return (
    <li className="list-none ms-4">
      <button
        type="button"
        aria-current={props.isActive ? "page" : undefined}
        onClick={() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id))}
        className={cn(
          "group flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-hidden ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset",
          props.isActive && "bg-accent",
        )}
      >
        <span className={cn("flex shrink-0", props.finished && FINISHED_ROW_ICON_CLASS)}>
          <StatusIcon status={status} />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            props.finished
              ? FINISHED_ROW_TITLE_CLASS
              : statusLabel
                ? "text-sidebar-foreground"
                : "text-sidebar-muted-foreground",
          )}
        >
          {label}
        </span>
        {statusLabel ? (
          <span className="shrink-0 text-sidebar-muted-foreground">{statusLabel}</span>
        ) : null}
      </button>
    </li>
  );
});
