import { ClipboardListIcon } from "lucide-react";

import { useEnvironmentFilter, useVisibleActiveLogicalBot } from "../../state/botRail";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { BotAvatar } from "../BotAvatar";
import { headquartersMember, useOpenBotHeadquarters } from "../sidebar/openBotHeadquarters";
import { useOpenProjectManager, useScopedProjectManager } from "../sidebar/openProjectManager";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The board's title, as the sidebar's header is while the board keeps the sidebar closed: the
 * scoped project's manager, else the picked bot. Either opens its thread. "Board" otherwise.
 */
export function BoardTitle() {
  const bot = useVisibleActiveLogicalBot();
  const connected = useConnectedEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  const openHeadquarters = useOpenBotHeadquarters();
  const manager = useScopedProjectManager();
  const openProjectManager = useOpenProjectManager();
  if (manager) {
    return (
      <h1 className="-ms-2.5 min-w-0 text-sm font-medium">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Open ${manager.title}'s project manager`}
                onClick={() => void openProjectManager(manager)}
              />
            }
          >
            <ClipboardListIcon />
            <span className="truncate">{manager.title}</span>
            <span className="truncate font-normal text-muted-foreground">Project manager</span>
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open {manager.title}'s project manager</TooltipPopup>
        </Tooltip>
      </h1>
    );
  }
  if (!bot || !headquartersMember(bot, connected, environmentFilter)) {
    return <h1 className="text-sm font-medium">Board</h1>;
  }
  return (
    <h1 className="-ms-2.5 min-w-0 text-sm font-medium">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Open ${bot.name}'s thread`}
              onClick={() => openHeadquarters(bot)}
            />
          }
        >
          <BotAvatar avatar={bot.avatar} color={bot.color} size={20} />
          <span className="truncate">{bot.name}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Open {bot.name}'s thread</TooltipPopup>
      </Tooltip>
    </h1>
  );
}
