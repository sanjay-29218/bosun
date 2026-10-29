import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import type { CrewRosterEntry, CrewRosterTone } from "@t3tools/client-runtime/state/crew-roster";

const TONE_TEXT: Record<CrewRosterTone, string> = {
  done: "text-success-foreground",
  working: "text-info-foreground",
  waiting: "text-warning-foreground",
  failed: "text-error-foreground",
  idle: "text-muted-foreground",
  next: "text-muted-foreground",
};

/** Where one of the crew stands, as an icon. */
export function CrewRosterIcon({ tone }: { readonly tone: CrewRosterTone }) {
  const className = cn("size-3.5 shrink-0", TONE_TEXT[tone]);
  switch (tone) {
    case "done":
      return <CircleCheckIcon aria-hidden className={className} />;
    case "working":
      return <CircleDashedIcon aria-hidden className={className} />;
    case "waiting":
      return <CircleDotIcon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    default:
      return <CircleIcon aria-hidden className={cn(className, "opacity-60")} />;
  }
}

/** Marks the crew row for the thread you're in, without hiding its status. Needs a `relative` row. */
export function CrewRosterHereMark() {
  return (
    <span aria-hidden className="absolute inset-y-2 start-0.5 w-0.5 rounded-full bg-primary" />
  );
}

/** Where one of the crew stands, in words, after its earlier tries. */
export function CrewRosterStatus({ entry }: { readonly entry: CrewRosterEntry }) {
  return (
    <span className="shrink-0 text-xs">
      {entry.tries.length > 0 ? (
        <span className="text-muted-foreground">{entry.tries.length + 1} tries · </span>
      ) : null}
      <span className={TONE_TEXT[entry.tone]}>{entry.status}</span>
    </span>
  );
}
