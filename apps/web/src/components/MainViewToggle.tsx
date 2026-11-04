import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { LayoutGridIcon, TextAlignJustifyIcon } from "lucide-react";
import { memo } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { useFeatureEnvironmentIds } from "./features/useFeatureBoard";
import { mainViewForPathname, useShowMainView } from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Flips the main area between the thread list and the feature board. Its icon is the view it
 * opens, like any button, not the one showing.
 * It appears once an environment runs features, or on the board so there is a way back.
 */
export const MainViewToggle = memo(function MainViewToggle() {
  const onBoard = useLocation({
    select: (location) => mainViewForPathname(location.pathname) === "board",
  });
  const supported = useFeatureEnvironmentIds().size > 0;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const showMainView = useShowMainView();
  if (!supported && !onBoard) return null;
  const shortcut = shortcutLabelForCommand(keybindings, "board.toggle");
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Button
          className="shrink-0 [-webkit-app-region:no-drag]"
          onClick={() => void showMainView(onBoard ? "list" : "board")}
          aria-label={onBoard ? "Show threads" : "Show feature board"}
          variant="ghost"
          size="icon-sm"
        >
          {onBoard ? (
            <TextAlignJustifyIcon className="size-4" />
          ) : (
            <LayoutGridIcon className="size-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {onBoard ? "Back to threads" : "Feature board"}
        {shortcut ? ` (${shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
});
