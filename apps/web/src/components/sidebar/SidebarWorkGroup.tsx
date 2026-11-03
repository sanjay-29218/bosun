import { featureTagColor } from "@t3tools/client-runtime/feature-tag";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { WorkGroup, WorkGroupEntry } from "@t3tools/client-runtime/state/work-groups";
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

/** One of a group's other threads, listed under its row: a crew member, or an attempt. */
export const SidebarWorkGroupEntry = memo(function SidebarWorkGroupEntry(props: {
  readonly entry: WorkGroupEntry<EnvironmentThreadShell>;
  readonly isActive: boolean;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
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
