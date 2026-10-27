import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";

/** Options most people leave alone, folded under a title that says what's set inside. */
export function DisclosureSection({
  title,
  summary,
  defaultOpen = false,
  children,
}: {
  readonly title: string;
  /** Shown beside a closed title, such as "On" or "2 filters". */
  readonly summary?: string | null;
  readonly defaultOpen?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group/disclosure flex min-h-7 w-full items-center gap-1.5 rounded-md text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <ChevronRightIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-panel-open/disclosure:rotate-90 motion-reduce:transition-none"
        />
        {title}
        {summary ? (
          <span className="ms-auto text-xs font-normal text-muted-foreground group-data-panel-open/disclosure:hidden">
            {summary}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="space-y-4 pt-3">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
