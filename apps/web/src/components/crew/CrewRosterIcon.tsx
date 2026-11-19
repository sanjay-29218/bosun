import type { FeatureStatus } from "@t3tools/client-runtime/state/crew-board";
import type { CrewRosterEntry } from "@t3tools/client-runtime/state/crew-roster";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleIcon,
  CirclePauseIcon,
  MessageCircleQuestionIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";

/** How a crew row's status looks; words it shares with features use their icons (`WORK_LOOK`). */
const STATUS_LOOK: Record<
  FeatureStatus,
  { readonly className: string; readonly icon: LucideIcon }
> = {
  working: { className: "text-info-foreground", icon: CircleDashedIcon },
  "needs-input": { className: "text-warning-foreground", icon: MessageCircleQuestionIcon },
  waiting: { className: "text-muted-foreground", icon: CirclePauseIcon },
  done: { className: "text-success-foreground", icon: CircleCheckIcon },
  failed: { className: "text-error-foreground", icon: CircleAlertIcon },
  "not-started": { className: "text-muted-foreground", icon: CircleIcon },
};

/** Where one of the crew stands, as an icon. */
export function CrewRosterIcon({ tone }: { readonly tone: FeatureStatus }) {
  const { icon: Icon, className } = STATUS_LOOK[tone];
  return <Icon aria-hidden className={cn("size-3.5 shrink-0", className)} />;
}

/** Marks the crew row for the thread you're in, without hiding its status. Needs a `relative` row. */
export function CrewRosterHereMark() {
  return (
    <span aria-hidden className="absolute inset-y-2 start-0.5 w-0.5 rounded-full bg-primary" />
  );
}

/** Where one of the crew stands, in words. */
export function CrewRosterStatus({ entry }: { readonly entry: CrewRosterEntry }) {
  return (
    <span className={cn("shrink-0 text-xs", STATUS_LOOK[entry.tone].className)}>
      {entry.status}
    </span>
  );
}
