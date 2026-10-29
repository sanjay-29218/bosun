import { useAtomValue } from "@effect/atom-react";
import { useLocation } from "@tanstack/react-router";
import { KanbanIcon, ListIcon } from "lucide-react";
import { memo } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useWorkflowEnvironmentIds } from "../features/useFeatureBoard";
import { useSidebar } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  isSidebarUtilityPage,
  mainViewForPathname,
  toggledMainView,
  useShowMainView,
} from "./mainAppLocation";

const VIEW_TOOLTIPS = { list: "Threads", board: "Feature board" } as const;

/**
 * The List / Board icon toggle in the sidebar's title row. It appears once an environment
 * runs workflows, or on the board itself so there is always a way back. Neither side
 * is pressed on a utility page, where the main area shows neither view.
 */
export const SidebarViewToggle = memo(function SidebarViewToggle() {
  const view = useLocation({
    select: (location) =>
      isSidebarUtilityPage(location.pathname) ? null : mainViewForPathname(location.pathname),
  });
  const supported = useWorkflowEnvironmentIds().size > 0;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const showMainView = useShowMainView();
  const { isMobile, setOpenMobile } = useSidebar();
  if (!supported && view !== "board") return null;
  const shortcut = shortcutLabelForCommand(keybindings, "board.toggle");
  return (
    <ToggleGroup
      aria-label="Main view"
      value={view ? [view] : []}
      onValueChange={(next) => {
        const value = next[0];
        if (value !== "list" && value !== "board") return;
        if (isMobile) setOpenMobile(false);
        void showMainView(value);
      }}
    >
      {(["list", "board"] as const).map((value) => (
        <Tooltip key={value}>
          <TooltipTrigger render={<Toggle value={value} aria-label={VIEW_TOOLTIPS[value]} />}>
            {value === "list" ? (
              <ListIcon className="size-3.5" />
            ) : (
              <KanbanIcon className="size-3.5" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {/* Only the side the shortcut would switch to shows it. */}
            {shortcut && value === toggledMainView(view)
              ? `${VIEW_TOOLTIPS[value]} (${shortcut})`
              : VIEW_TOOLTIPS[value]}
          </TooltipPopup>
        </Tooltip>
      ))}
    </ToggleGroup>
  );
});
