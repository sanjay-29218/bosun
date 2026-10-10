import { useAtomValue } from "@effect/atom-react";
import { collectNeedsYou, type NeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { memo } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { needsYouThreadsAtom } from "../../state/needsYou";
import { formatRelativeTime } from "../../timestampFormat";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";

const SHELF_ROWS = 5;
const EXPANDED_KEY = "t3code:sidebar:needs-you-expanded";

const KIND_LABELS: Record<NeedsYouKind, { readonly label: string; readonly className: string }> = {
  approval: { label: "Approval", className: "text-warning-foreground" },
  question: { label: "Input", className: "text-indigo-600 dark:text-indigo-300" },
  problem: { label: "Failed", className: "text-error" },
};

/**
 * Everything waiting on you, oldest first, at the top of the sidebar. It disappears when
 * nothing waits. Rows repeat threads that also sit in their own shelf; this one is a queue.
 */
export const SidebarNeedsYouShelf = memo(function SidebarNeedsYouShelf() {
  const navigate = useNavigate();
  const shells = useAtomValue(needsYouThreadsAtom);
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_KEY, true, Schema.Boolean);
  if (shells.length === 0) return null;
  const items = collectNeedsYou({ cards: [], shells })
    .flatMap((group) => group.items)
    .toSorted((a, b) => a.since.localeCompare(b.since));
  return (
    <section aria-label="Needs you" className="mb-1 flex flex-col gap-px">
      <div className="mx-0.5 h-8">
        <CollapsibleSectionHeader
          onClick={() => setExpanded(!expanded)}
          expanded={expanded}
          tone="emphasized"
        >
          {`Needs you (${items.length})`}
        </CollapsibleSectionHeader>
      </div>
      {expanded
        ? items.slice(0, SHELF_ROWS).map((item) => {
            if (item.type !== "thread") return null;
            const { shell } = item;
            const kind = KIND_LABELS[item.kind];
            const waiting = formatRelativeTime(item.since)?.value;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: shell.environmentId, threadId: shell.id },
                  })
                }
                className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-hidden ring-ring hover:bg-accent focus-visible:ring-2"
              >
                <span className={cn("shrink-0 font-medium", kind.className)}>{kind.label}</span>
                <span className="min-w-0 flex-1 truncate text-sidebar-foreground">
                  {shell.title}
                </span>
                {waiting ? (
                  <span className="shrink-0 text-sidebar-muted-foreground">{waiting}</span>
                ) : null}
              </button>
            );
          })
        : null}
      {expanded && items.length > SHELF_ROWS ? (
        <Link
          to="/features"
          search={{ needsYou: true }}
          className="rounded-md px-2 py-1 text-xs text-sidebar-muted-foreground hover:bg-accent"
        >
          Show all {items.length}
        </Link>
      ) : null}
    </section>
  );
});
