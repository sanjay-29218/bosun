import { SquarePenIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";

import { SidebarMenuButton } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** New thread as the sidebar's first action, under the bot. Shift+click starts it in the current project. */
export function SidebarNewThreadRow({
  onNewThread,
  disabled,
  shortcutLabel,
  newThreadInProjectShortcutLabel,
  showInProjectHint,
}: {
  readonly onNewThread: (event: ReactMouseEvent) => void;
  readonly disabled: boolean;
  readonly shortcutLabel: string | null | undefined;
  readonly newThreadInProjectShortcutLabel: string | null | undefined;
  readonly showInProjectHint: boolean;
}) {
  const button = (
    <SidebarMenuButton disabled={disabled} onClick={onNewThread}>
      <SquarePenIcon />
      <span className="min-w-0 flex-1">New thread</span>
      {shortcutLabel ? (
        <span className="shrink-0 text-xs text-sidebar-muted-foreground">{shortcutLabel}</span>
      ) : null}
    </SidebarMenuButton>
  );
  if (!showInProjectHint) return <div className="mb-1">{button}</div>;
  return (
    <div className="mb-1">
      <Tooltip>
        <TooltipTrigger render={button} />
        <TooltipPopup side="right">
          New thread in current project: Shift+click
          {newThreadInProjectShortcutLabel ? ` (${newThreadInProjectShortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}
