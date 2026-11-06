import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadNeedsYouKind } from "@t3tools/client-runtime/state/crew-board";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { botHeadquartersThreadId, projectHeadquartersThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ClipboardListIcon, PencilIcon, SettingsIcon } from "lucide-react";
import { memo, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentFilter, useVisibleActiveLogicalBot } from "../../state/botRail";
import { useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { BotAvatar } from "../BotAvatar";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { searchableSetting } from "../settings/settingsSearch";
import { BOTS_PATH } from "./mainAppLocation";
import { headquartersMember, useOpenBotHeadquarters } from "./openBotHeadquarters";
import {
  type ScopedProjectManager,
  useOpenProjectManager,
  useScopedProjectManager,
} from "./openProjectManager";

/** The working or waiting dot for a standing thread, and its label for screen readers. */
function useStandingStatus(ref: Parameters<typeof useThreadShell>[0]) {
  const shell = useThreadShell(ref);
  const waiting = shell !== null && threadNeedsYouKind(shell) !== null;
  const working = shell !== null && !waiting && isThreadWorking(shell);
  return { waiting, working, status: waiting ? "needs you" : working ? "working" : null };
}

function StatusDot({ waiting, working }: { readonly waiting: boolean; readonly working: boolean }) {
  if (waiting) return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-warning" />;
  if (working) return <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />;
  return null;
}

/**
 * The sidebar's title row in place of the wordmark, which `fallback` is while no bot is picked.
 * Scoped to one project, it is that project's manager; otherwise the picked bot, whose
 * headquarters is its one thread over every project it owns.
 */
export const SidebarBotHeader = memo(function SidebarBotHeader({
  onBackdrop,
  fallback,
}: {
  readonly onBackdrop: boolean;
  readonly fallback: ReactNode;
}) {
  const manager = useScopedProjectManager();
  if (manager) return <ProjectManagerHeader manager={manager} onBackdrop={onBackdrop} />;
  return <BotHeader onBackdrop={onBackdrop} fallback={fallback} />;
});

const headerButtonClassName = (onBackdrop: boolean, open: boolean) =>
  cn(
    "flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
    onBackdrop
      ? "text-white hover:bg-white/15"
      : "text-sidebar-foreground hover:bg-sidebar-row-hover",
    open && (onBackdrop ? "bg-white/15" : "bg-sidebar-row-selected"),
  );

function ProjectManagerHeader({
  manager,
  onBackdrop,
}: {
  readonly manager: ScopedProjectManager;
  readonly onBackdrop: boolean;
}) {
  const openProjectManager = useOpenProjectManager();
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const threadId = projectHeadquartersThreadId(manager.projectId);
  const { waiting, working, status } = useStandingStatus(
    scopeThreadRef(manager.environmentId, threadId),
  );
  const open = useParams({ strict: false, select: (params) => params.threadId === threadId });
  return (
    <div className="group/bot-header relative z-10 ml-[calc(var(--workspace-titlebar-content-left)-0.375rem)] hidden min-w-0 flex-1 items-center md:flex">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={`Open ${manager.title}'s project manager${status ? `, ${status}` : ""}`}
              aria-current={open ? "page" : undefined}
              onClick={() => {
                if (isMobile) setOpenMobile(false);
                void openProjectManager(manager);
              }}
              className={headerButtonClassName(onBackdrop, open)}
            />
          }
        >
          <ClipboardListIcon aria-hidden className="size-4 shrink-0" />
          <span className="max-w-[60%] shrink-0 truncate">{manager.title}</span>
          <span
            className={cn(
              "min-w-0 truncate font-normal",
              onBackdrop ? "text-white/75" : "text-muted-foreground",
            )}
          >
            Project manager
          </span>
          <StatusDot waiting={waiting} working={working} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Open {manager.title}'s project manager</TooltipPopup>
      </Tooltip>
      <span className="ms-auto opacity-0 group-hover/bot-header:opacity-100 focus-within:opacity-100">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost-muted"
                size="icon-xs"
                aria-label="Project manager settings"
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                  void navigate({
                    to: "/settings/projects",
                    search: { project: manager.projectKey },
                    hash: searchableSetting("project-manager").id,
                  });
                }}
              />
            }
          >
            <SettingsIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Project manager settings</TooltipPopup>
        </Tooltip>
      </span>
    </div>
  );
}

function BotHeader({
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
  const { waiting, working, status } = useStandingStatus(
    member && threadId ? scopeThreadRef(member.environmentId, threadId) : null,
  );
  const open = useParams({ strict: false, select: (params) => params.threadId === threadId });
  if (bot === null || member === undefined) return fallback;

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
              className={headerButtonClassName(onBackdrop, open)}
            />
          }
        >
          <BotAvatar avatar={bot.avatar} color={bot.color} size="xs" shaded={false} />
          <span className="truncate">{bot.name}</span>
          <StatusDot waiting={waiting} working={working} />
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
                    to: BOTS_PATH,
                    search: { environmentId: member.environmentId, botId: member.botId },
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
}
