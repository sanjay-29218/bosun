import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { KanbanIcon } from "lucide-react";
import { memo } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useWorkflowEnvironmentIds } from "./features/useFeatureBoard";
import { mainViewForPathname, useShowMainView } from "./sidebar/mainAppLocation";
import { Toggle } from "./ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Flips the main area between the thread list and the feature board, pressed on the board.
 * It appears once an environment runs workflows, or on the board so there is a way back.
 */
export const MainViewToggle = memo(function MainViewToggle() {
  const onBoard = useLocation({
    select: (location) => mainViewForPathname(location.pathname) === "board",
  });
  const supported = useWorkflowEnvironmentIds().size > 0;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const showMainView = useShowMainView();
  if (!supported && !onBoard) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "board.toggle");
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={onBoard}
          onPressedChange={() => void showMainView(onBoard ? "list" : "board")}
          aria-label="Toggle feature board"
          variant="ghost"
          size="sm"
        >
          <KanbanIcon className="size-4" />
        </Toggle>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {onBoard ? "Back to threads" : "Feature board"}
        {shortcut ? ` (${shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
});
