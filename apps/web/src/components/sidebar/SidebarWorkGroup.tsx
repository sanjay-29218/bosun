import { crewHandoffRowLabel } from "@t3tools/client-runtime/state/crew-handoffs";
import { featureTagColor } from "@t3tools/client-runtime/crew-stage";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  WorkGroup,
  WorkGroupEntry,
  WorkStageStatus,
} from "@t3tools/client-runtime/state/work-groups";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";
import { memo } from "react";

import { cn } from "../../lib/utils";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

export type SidebarWorkGroup = WorkGroup<EnvironmentThreadShell>;

const STAGE_CLASSES: Record<WorkStageStatus, string> = {
  done: "bg-muted-foreground/45",
  working: "bg-info",
  "needs-you": "bg-warning",
  failed: "bg-error",
  paused: "bg-muted-foreground/70",
  pending: "bg-border",
};

const STATUS_LABELS: Partial<Record<SidebarThreadStatus, string>> = {
  approval: "Approval",
  input: "Input",
  working: "Working",
  failed: "Failed",
};

const workColor = (group: SidebarWorkGroup) =>
  featureTagColor(group.primary.feature?.id ?? group.primary.crewRequest?.id ?? group.key);

/** The meta line of a feature or bot request row: its color and where it is. */
export function SidebarWorkGroupSummary(props: { readonly group: SidebarWorkGroup }) {
  const { group } = props;
  const chain =
    group.kind === "request"
      ? [group.primary, ...group.children.map((entry) => entry.thread)]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((thread) => thread.crewRequest?.member ?? thread.title)
      : [];
  return (
    <span className="flex min-w-0 shrink items-center gap-1.5">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: workColor(group) }}
      />
      {group.stages.length > 0 ? <WorkStageStrip stages={group.stages} /> : null}
      {group.stageLine ? (
        <span className="shrink-0 text-muted-foreground">{group.stageLine}</span>
      ) : chain.length > 0 ? (
        <span className="min-w-0 truncate text-muted-foreground">
          {chain.length > 3
            ? `${chain.slice(0, 2).join(" → ")} → +${chain.length - 2}`
            : chain.join(" → ")}
        </span>
      ) : null}
    </span>
  );
}

/** One segment per workflow stage: done, the current stage in its state's color, then the rest. */
export function WorkStageStrip(props: { readonly stages: ReadonlyArray<WorkStageStatus> }) {
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center gap-0.5">
      {props.stages.map((status, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- stages are positional
        <span key={index} className={cn("h-1 w-2.5 rounded-full", STAGE_CLASSES[status])} />
      ))}
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

/** One of a group's other threads, listed under its row: a stage, an attempt, or a helper. */
export const SidebarWorkGroupEntry = memo(function SidebarWorkGroupEntry(props: {
  readonly entry: WorkGroupEntry<EnvironmentThreadShell>;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread, label } = props.entry;
  const status = resolveSidebarThreadStatus(thread);
  const statusLabel =
    status === "waiting"
      ? (crewHandoffRowLabel(thread.crewHandoffs) ?? undefined)
      : STATUS_LABELS[status];
  return (
    <li className="list-none ms-4">
      <button
        type="button"
        aria-current={props.isActive ? "page" : undefined}
        onClick={() => props.onOpen(scopeThreadRef(thread.environmentId, thread.id))}
        className={cn(
          "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-hidden ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset",
          props.isActive && "bg-accent",
        )}
      >
        <StatusIcon status={status} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate",
            statusLabel ? "text-sidebar-foreground" : "text-sidebar-muted-foreground",
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
