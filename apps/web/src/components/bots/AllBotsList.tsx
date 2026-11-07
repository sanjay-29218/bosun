import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  BotActivity,
  LogicalBot,
  LogicalBotMember,
} from "@t3tools/client-runtime/state/bot-rail";
import {
  botHeadquartersThreadId,
  headquartersProjectId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { ClipboardListIcon, LayoutGridIcon } from "lucide-react";

import { isElectron } from "../../env";
import { cn } from "../../lib/utils";
import {
  useActivityByLogicalBot,
  useEnvironmentFilter,
  useNeedsYouByLogicalBot,
  useSelectLogicalBot,
  useVisibleLogicalBots,
} from "../../state/botRail";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import { useConnectedEnvironmentIds } from "../../state/environments";
import { BotAvatar } from "../BotAvatar";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { RelativeTimeLabel } from "../sidebar/SidebarThreadRow";
import { headquartersMember, useOpenBotHeadquarters } from "../sidebar/openBotHeadquarters";
import { useOpenProjectManager } from "../sidebar/openProjectManager";
import { useStandingStatus } from "../sidebar/useStandingStatus";
import { SidebarContent, SidebarGroup, useSidebar } from "../ui/sidebar";
import { allBotsRowSummary } from "./allBots.logic";

const rowClassName =
  "flex w-full min-w-0 cursor-pointer items-center rounded-md px-2 text-start outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

/** The sidebar while All bots is picked: each bot's headquarters, then the project managers. */
export function AllBotsSidebar() {
  const bots = useVisibleLogicalBots();
  const needsYou = useNeedsYouByLogicalBot();
  const activity = useActivityByLogicalBot();
  const connected = useConnectedEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent
        className="min-h-full"
        fixedHeader={
          <SidebarGroup className="z-[1]">
            <h2 className="flex h-8 min-w-0 items-center gap-2 px-2 text-sm font-medium text-sidebar-foreground">
              <LayoutGridIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
              All bots
            </h2>
          </SidebarGroup>
        }
      >
        <SidebarGroup>
          <ul className="flex flex-col gap-0.5" aria-label="Bots">
            {bots.map((bot) => (
              <BotRow
                key={bot.key}
                bot={bot}
                member={headquartersMember(bot, connected, environmentFilter)}
                needsYou={needsYou.get(bot.key) ?? 0}
                activity={activity.get(bot.key)}
              />
            ))}
          </ul>
          <ProjectManagers />
        </SidebarGroup>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

// Rows take their own counts so one change doesn't make every row rebuild every bot's totals.
function BotRow({
  bot,
  member,
  needsYou,
  activity,
}: {
  readonly bot: LogicalBot;
  readonly member: LogicalBotMember | undefined;
  readonly needsYou: number;
  readonly activity: BotActivity | undefined;
}) {
  const selectBot = useSelectLogicalBot();
  const openHeadquarters = useOpenBotHeadquarters();
  const { isMobile, setOpenMobile } = useSidebar();
  const threadId = member ? botHeadquartersThreadId(member.botId) : null;
  const shell = useThreadShell(
    member && threadId ? scopeThreadRef(member.environmentId, threadId) : null,
  );
  const open = useParams({ strict: false, select: (params) => params.threadId === threadId });
  const { mark, preview, time } = allBotsRowSummary(
    needsYou,
    activity,
    shell?.source.latestVisibleMessage,
  );
  return (
    <li>
      <button
        type="button"
        aria-current={open ? "page" : undefined}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          selectBot(bot);
          openHeadquarters(bot);
        }}
        className={cn(rowClassName, "gap-2.5 py-2", open && "bg-sidebar-row-selected")}
      >
        <BotAvatar avatar={bot.avatar} color={bot.color} size={32} shaded={false} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-sidebar-foreground">
              {bot.name}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              <RelativeTimeLabel timestamp={time} />
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {mark === "working" ? (
              <span className="size-1.5 shrink-0 rounded-full bg-info">
                <span className="sr-only">Working</span>
              </span>
            ) : mark === "needs-you" ? (
              <span className="shrink-0 rounded-sm bg-warning px-1 text-2xs leading-4 font-semibold text-black">
                Needs you
              </span>
            ) : null}
            <span className="min-w-0 truncate text-xs text-muted-foreground">{preview}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

interface ProjectManagerEntry {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
}

/** Each project whose manager thread exists and isn't archived, by title. */
function ProjectManagers() {
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const environmentFilter = useEnvironmentFilter();
  const managers = (() => {
    const entries: ProjectManagerEntry[] = [];
    for (const shell of shells) {
      const projectId = headquartersProjectId(shell.id);
      if (projectId === null || shell.archivedAt !== null) continue;
      if (environmentFilter !== null && !environmentFilter.has(shell.environmentId)) continue;
      const project = projects.find(
        (candidate) =>
          candidate.environmentId === shell.environmentId && candidate.id === projectId,
      );
      if (!project) continue;
      entries.push({
        key: `${shell.environmentId}:${shell.id}`,
        environmentId: shell.environmentId,
        projectId,
        threadId: shell.id,
        title: project.title,
      });
    }
    return entries.toSorted((left, right) => left.title.localeCompare(right.title));
  })();
  if (managers.length === 0) return null;
  return (
    <section aria-label="Project managers" className="mt-3 border-t border-sidebar-border pt-3">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">Project managers</h3>
      <ul className="flex flex-col gap-0.5">
        {managers.map((manager) => (
          <ProjectManagerRow key={manager.key} manager={manager} />
        ))}
      </ul>
    </section>
  );
}

function ProjectManagerRow({ manager }: { readonly manager: ProjectManagerEntry }) {
  const openProjectManager = useOpenProjectManager();
  const { isMobile, setOpenMobile } = useSidebar();
  const { waiting, working, done } = useStandingStatus(
    scopeThreadRef(manager.environmentId, manager.threadId),
  );
  const open = useParams({
    strict: false,
    select: (params) => params.threadId === manager.threadId,
  });
  const state = waiting ? "Needs you" : working ? "Working" : done ? "Done" : null;
  return (
    <li>
      <button
        type="button"
        aria-current={open ? "page" : undefined}
        onClick={() => {
          if (isMobile) setOpenMobile(false);
          void openProjectManager(manager);
        }}
        className={cn(rowClassName, "h-8 gap-2", open && "bg-sidebar-row-selected")}
      >
        <ClipboardListIcon aria-hidden className="size-4 shrink-0 text-(--sidebar-icon-color)" />
        <span className="min-w-0 flex-1 truncate text-sm text-sidebar-foreground">
          {manager.title}
        </span>
        {state ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                waiting ? "bg-warning" : working ? "bg-info" : "bg-sidebar-foreground",
              )}
            />
            {state}
          </span>
        ) : null}
      </button>
    </li>
  );
}
