import { CornerLeftUpIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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
