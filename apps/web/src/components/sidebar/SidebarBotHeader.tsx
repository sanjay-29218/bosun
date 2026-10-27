import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadNeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { botHeadquartersThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentFilter, useVisibleActiveLogicalBot } from "../../state/botRail";
import { useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { BotAvatar } from "../BotAvatar";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { headquartersMember, useOpenBotHeadquarters } from "./openBotHeadquarters";

/**
 * The picked bot, in the sidebar's title row in place of the wordmark, which `fallback` is
 * while no bot is picked. Clicking it opens the bot's headquarters, its one thread over every
 * project it owns. A dot shows while that thread works or waits on you.
 */
export const SidebarBotHeader = memo(function SidebarBotHeader({
  onBackdrop,
  fallback,
}: {
  readonly onBackdrop: boolean;
  readonly fallback: ReactNode;
}) {
  const bot = useVisibleActiveLogicalBot();
  const connected = useConnectedEnvironmentIds();
  const openHeadquarters = useOpenBotHeadquarters();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentFilter = useEnvironmentFilter();
  const member = bot ? headquartersMember(bot, connected, environmentFilter) : undefined;
  const threadId = member ? botHeadquartersThreadId(member.botId) : null;
  const shell = useThreadShell(
    member && threadId ? scopeThreadRef(member.environmentId, threadId) : null,
  );
  const open = useParams({ strict: false, select: (params) => params.threadId === threadId });
  if (bot === null || member === undefined) return fallback;

  const waiting = shell !== null && threadNeedsYouKind(shell) !== null;
  const working = shell !== null && !waiting && isThreadWorking(shell);
  const status = waiting ? "needs you" : working ? "working" : null;
  return (
    <div className="group/bot-header relative z-10 ml-[calc(var(--workspace-titlebar-content-left)-0.375rem)] hidden min-w-0 flex-1 items-center md:flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Open ${bot.name}'s thread${status ? `, ${status}` : ""}`}
              aria-current={open ? "page" : undefined}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                openHeadquarters(bot);
              }}
              className={cn(
                "flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                onBackdrop
                  ? "text-white hover:bg-white/15"
                  : "text-sidebar-foreground hover:bg-sidebar-row-hover",
                open && (onBackdrop ? "bg-white/15" : "bg-sidebar-row-selected"),
              )}
            />
          }
        >
          <BotAvatar avatar={bot.avatar} color={bot.color} size="xs" shaded={false} />
          <span className="truncate">{bot.name}</span>
          {waiting ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />
          ) : working ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom">Open {bot.name}'s thread</TooltipPopup>
      </Tooltip>
      {/* The bot's own settings, where the bot is; the gear in the rail is the app's. */}
      <span className="ms-auto opacity-0 group-hover/bot-header:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Edit ${bot.name}`}
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  void navigate({
                    to: "/settings/bots",
                    search: { machine: member.environmentId },
                  });
                }}
              />
            }
          >
            <PencilIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Edit {bot.name}</TooltipPopup>
        </Tooltip>
      </span>
    </div>
  );
});
