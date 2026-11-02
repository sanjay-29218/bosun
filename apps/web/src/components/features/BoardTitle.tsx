import { useEnvironmentFilter, useVisibleActiveLogicalBot } from "../../state/botRail";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { BotAvatar } from "../BotAvatar";
import { headquartersMember, useOpenBotHeadquarters } from "../sidebar/openBotHeadquarters";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The board's title: the picked bot, which opens its thread, as the sidebar's header does while
 * the board keeps the sidebar closed. "Board" while no one bot is picked.
 */
export function BoardTitle() {
  const bot = useVisibleActiveLogicalBot();
  const connected = useConnectedEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  const openHeadquarters = useOpenBotHeadquarters();
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
          <BotAvatar avatar={bot.avatar} color={bot.color} size="xs" shaded={false} />
          <span className="truncate">{bot.name}</span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">Open {bot.name}'s thread</TooltipPopup>
      </Tooltip>
    </h1>
  );
}
