import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { logicalBotProjectKeys } from "@t3tools/client-runtime/state/bot-rail";
import { threadNeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { botHeadquartersThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { memo, useMemo } from "react";

import { cn } from "../../lib/utils";
import {
  useEnvironmentFilter,
  useVisibleActiveLogicalBot,
  useVisibleLogicalBots,
} from "../../state/botRail";
import { useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { environmentProjects } from "../../state/projects";
import { BotAvatar } from "../BotAvatar";
import { useSidebar } from "../ui/sidebar";
import { headquartersMember, useOpenBotHeadquarters } from "./openBotHeadquarters";

/**
 * The picked bot, above List / Board. Clicking it opens the bot's headquarters, its one
 * thread over every project it owns, which therefore stays out of the thread list. A dot
 * shows while that thread works and a count when it waits on you.
 */
export const SidebarBotHeader = memo(function SidebarBotHeader() {
  const bot = useVisibleActiveLogicalBot();
  const bots = useVisibleLogicalBots();
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const connected = useConnectedEnvironmentIds();
  const openHeadquarters = useOpenBotHeadquarters();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentFilter = useEnvironmentFilter();
  const member = bot ? headquartersMember(bot, connected, environmentFilter) : undefined;
  const threadId = member ? botHeadquartersThreadId(member.botId) : null;
  const shell = useThreadShell(
    member && threadId ? scopeThreadRef(member.environmentId, threadId) : null,
  );
  const open = useParams({ strict: false, select: (params) => params.threadId === threadId });
  const projectCount = useMemo(() => {
    if (bot === null) return 0;
    const owned = logicalBotProjectKeys(
      bot,
      bots,
      projects.filter((project) => !project.isScratch),
    );
    return owned.size;
  }, [bot, bots, projects]);
  if (bot === null || member === undefined) return null;

  const waiting = shell !== null && threadNeedsYouKind(shell) !== null;
  const working = shell !== null && !waiting && isThreadWorking(shell);
  const status = waiting ? "needs you" : working ? "working" : null;
  return (
    <button
      type="button"
      aria-label={`Open ${bot.name}'s thread${status ? `, ${status}` : ""}`}
      aria-current={open ? "page" : undefined}
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        openHeadquarters(bot);
      }}
      className={cn(
        "mb-2 flex w-full items-center gap-2.5 rounded-lg border border-sidebar-border px-2.5 py-2 text-left outline-none transition-colors hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        open && "bg-sidebar-row-selected",
      )}
    >
      <BotAvatar avatar={bot.avatar} color={bot.color} size="sm" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-sidebar-foreground">{bot.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {projectCount === 1 ? "1 project" : `${projectCount} projects`}
        </span>
      </span>
      {waiting ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
      ) : working ? (
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-info" />
      ) : null}
    </button>
  );
});
