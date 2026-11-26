import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  activityForProjects,
  botRailSignal,
  createLogicalBotResolver,
  needsYouForProjects,
  pinnedProjectManagers,
  projectOwner,
  type BotActivity,
  type BotRailSignal,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import {
  botHeadquartersThreadId,
  headquartersProjectId,
  projectHeadquartersThreadId,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  BotIcon,
  ChartNoAxesColumnIcon,
  ClockIcon,
  FoldersIcon,
  ServerIcon,
  SettingsIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { memo, useEffect, type MouseEvent, type ReactNode } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { useSnapResizeDrag } from "../../hooks/useSnapResizeDrag";
import { botJumpCommandForIndex, botJumpIndexFromCommand } from "../../keybindings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { cn, isMacPlatform } from "../../lib/utils";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useHasUnseenAutomationFailure } from "../../state/automations";
import {
  PROJECTS_RAIL_KEY,
  useActivityByLogicalBot,
  useActivityByProject,
  useAllVisibleLogicalBots,
  useEnvironmentFilter,
  useHiddenNeedsYouCount,
  useNeedsYouByLogicalBot,
  useNeedsYouByProject,
  useSelectLogicalBot,
  useVisibleActiveLogicalBot,
  useVisibleLogicalBots,
} from "../../state/botRail";
import { useProjects, useQuietThreadShells, useThreadShell } from "../../state/entities";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  useEnvironments,
  useIssuesSupported,
  usePullRequestsSupported,
} from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  BOT_RAIL_COLLAPSED_WIDTH,
  BOT_RAIL_DEFAULT_WIDTH,
  BOT_RAIL_MAX_WIDTH,
  BOT_RAIL_SNAP,
  botRailLayoutAfterDrag,
  useUiStateStore,
} from "../../uiStateStore";
import { BotAvatar } from "../BotAvatar";
import { ProjectManagerAvatar, useProjectManagerIcon } from "../bots/ProjectManagerIcon";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { IssueGlyph } from "../issue/issuePresentation";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { botListRowSummary } from "./botListRow.logic";
import {
  AUTOMATIONS_PATH,
  BOTS_LIST_PATH,
  isSidebarUtilityPage,
  readBotHref,
  rememberBotHref,
  useRailDestination,
  useSelectRailProjects,
  useSwitchBotMainView,
} from "./mainAppLocation";
import { headquartersMember, useOpenBotHeadquarters } from "./openBotHeadquarters";
import { useOpenProjectManager } from "./openProjectManager";
import { RelativeTimeLabel } from "./SidebarThreadRow";
import { supersedeStandingOpen } from "./standingOpen";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

/** The rail's width in px: the icon column, or the expanded list's chosen width. */
export function useBotRailWidth(): number {
  const collapsed = useUiStateStore((store) => store.botRailCollapsed);
  const width = useUiStateStore((store) => store.botRailWidth);
  return collapsed ? BOT_RAIL_COLLAPSED_WIDTH : width;
}

interface RailProjectManager {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  /** The sidebar's key for the project, which scopes the thread list to it. */
  readonly projectKey: string;
  /** `${environmentId}:${projectId}` of the projects picking it lists, on shown environments. */
  readonly memberProjectKeys: ReadonlyArray<string>;
  /** Its bot, here or on the machine it lives on. */
  readonly owner: { readonly environmentId: EnvironmentId; readonly botId: string } | null;
  /** The machine it lives on, when the project is on several. */
  readonly homeLabel: string | null;
}

/**
 * Each pinned project manager, by title, whether or not its thread exists yet: opening one makes
 * it. A manager turned off (its thread archived) is left out.
 */
function useRailProjectManagers(): ReadonlyArray<RailProjectManager> {
  const shells = useQuietThreadShells();
  const projects = useProjects();
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const environmentFilter = useEnvironmentFilter();
  const archivedManagers = new Set(
    shells.flatMap((shell) => {
      const projectId = headquartersProjectId(shell.id);
      return projectId === null || shell.archivedAt === null
        ? []
        : [`${shell.environmentId}:${projectId}`];
    }),
  );
  const managerEnvironmentIds = new Set(
    environments
      .filter(
        (environment) =>
          environment.serverConfig?.environment.capabilities.workflows === true &&
          (environmentFilter === null || environmentFilter.has(environment.environmentId)),
      )
      .map((environment) => environment.environmentId),
  );
  return pinnedProjectManagers({ projects, managerEnvironmentIds, archivedManagers }).flatMap(
    (project) => {
      const group = groups.find((candidate) =>
        candidate.memberProjects.some(
          (member) => member.environmentId === project.environmentId && member.id === project.id,
        ),
      );
      if (!group) return [];
      const threadId = projectHeadquartersThreadId(project.id);
      return [
        {
          key: `${project.environmentId}:${threadId}`,
          environmentId: project.environmentId,
          projectId: project.id,
          threadId,
          title: project.title,
          projectKey: group.projectKey,
          memberProjectKeys: group.memberProjects
            .filter(
              (member) => environmentFilter === null || environmentFilter.has(member.environmentId),
            )
            .map((member) => `${member.environmentId}:${member.id}`),
          owner: projectOwner(project),
          homeLabel:
            new Set(group.memberProjects.map((member) => member.environmentId)).size > 1
              ? (environments.find(
                  (environment) => environment.environmentId === project.environmentId,
                )?.label ?? null)
              : null,
        },
      ];
    },
  );
}

/**
 * The bot list: bots and project managers scroll above a pinned group of places, an Update row
 * while there is one, the environment filter, Usage and Settings. `window` pins it to the
 * window's left edge, resizable; `sheet` puts its icons in the mobile sheet.
 */
export const BotRail = memo(function BotRail({
  placement,
}: {
  readonly placement: "window" | "sheet";
}) {
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const bots = useVisibleLogicalBots();
  const allBots = useAllVisibleLogicalBots();
  const active = useVisibleActiveLogicalBot();
  const needsYou = useNeedsYouByLogicalBot();
  const activity = useActivityByLogicalBot();
  const needsYouByProject = useNeedsYouByProject();
  const activityByProject = useActivityByProject();
  const selectBot = useSelectLogicalBot();
  const switchBotMainView = useSwitchBotMainView();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const managers = useRailProjectManagers();
  const openProjectManager = useOpenProjectManager();
  const scopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const setScopeKeys = useUiStateStore((store) => store.setSidebarProjectScopeKeys);
  const selectRailProjects = useSelectRailProjects();
  const collapsedPreference = useUiStateStore((store) => store.botRailCollapsed);
  // The phone sheet keeps the icon column, leaving the thread list most of its width.
  const collapsed = placement === "sheet" || collapsedPreference;
  const multipleBots = bots.length > 1;

  const openHeadquarters = useOpenBotHeadquarters();
  const navigate = useNavigate();
  const destination = useRailDestination();
  const onBots = destination === "bots";
  const onUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const scopedManager =
    onBots && scopeKeys.length === 1
      ? (managers.find((manager) => manager.projectKey === scopeKeys[0]) ?? null)
      : null;
  // Switching saves and restores List / Board per bot.
  const switchTo = (bot: LogicalBot) => {
    supersedeStandingOpen();
    if (bot.key !== active?.key || onUtilityPage) switchBotMainView(() => selectBot(bot));
  };
  // A click returns to where the bot was left, or opens its headquarters the first time and when
  // it's the bot you're on; Mod+click always opens its headquarters. Selects without switchTo,
  // whose view switch would race this navigation.
  const select = (bot: LogicalBot, event: MouseEvent) => {
    const same = bot.key === active?.key;
    // Picking a bot shows its threads, so a closed thread list opens again.
    if (isMobile) setOpenMobile(false);
    else setOpen(true);
    // A bot shows its threads across all its projects.
    if (scopeKeys.length > 0) setScopeKeys([]);
    if (!same) rememberBotHref(active?.key ?? PROJECTS_RAIL_KEY);
    const href = same || event.metaKey || event.ctrlKey ? undefined : readBotHref(bot.key);
    if (!same) selectBot(bot);
    if (href === undefined) {
      openHeadquarters(bot);
      return;
    }
    supersedeStandingOpen();
    void navigate({ href });
  };
  // A pinned owner is picked first. Either way the scope shows the manager's project, so one whose
  // bot isn't pinned (or has no bot) still shows under the bot that stays picked.
  const selectManager = (manager: RailProjectManager) => {
    if (isMobile) setOpenMobile(false);
    else setOpen(true);
    const ownerKey =
      manager.owner === null
        ? null
        : createLogicalBotResolver(allBots)(manager.owner.environmentId, manager.owner.botId);
    const owner = bots.find((bot) => bot.key === ownerKey);
    if (owner && owner.key !== active?.key) {
      rememberBotHref(active?.key ?? PROJECTS_RAIL_KEY);
      selectBot(owner);
    }
    setScopeKeys([manager.projectKey]);
    void openProjectManager(manager);
  };
  // Every project with its threads, on every machine, whatever bot owns it, or none.
  const selectProjects = () => {
    if (isMobile) setOpenMobile(false);
    else setOpen(true);
    void selectRailProjects();
  };
  const projectsActive = onBots && scopedManager === null && active === null;
  const headquartersHint = `${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click to open its headquarters`;

  // Mod+1-9 switches bots while there are several (thread jumps then use Ctrl+Mod+1-9); the
  // `bot.inbox` command collapses or expands the list.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a window keydown listener for the bot list shortcuts, removed on unmount.
  useEffect(() => {
    if (placement !== "window") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), multipleBots },
      });
      if (command === "bot.inbox") {
        event.preventDefault();
        useUiStateStore.getState().toggleBotRailCollapsed();
        return;
      }
      const index = botJumpIndexFromCommand(command ?? "");
      const bot = index === null || !multipleBots ? undefined : bots[index];
      if (bot === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      switchTo(bot);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, multipleBots, placement, switchTo, bots]);

  const shortcutFor = (command: Parameters<typeof shortcutLabelForCommand>[1]) =>
    multipleBots
      ? shortcutLabelForCommand(keybindings, command, { context: { multipleBots } })
      : null;

  return (
    <nav
      aria-label="Bots"
      data-collapsed={collapsed ? "" : undefined}
      // Takes the sidebar's palette so every theme paints the rail and sidebar as one surface.
      data-app-sidebar=""
      className={cn(
        "group/rail flex w-(--sidebar-leading-width) shrink-0 flex-col bg-sidebar surface-grain text-sidebar-foreground",
        placement === "window" ? "relative z-20 hidden md:flex" : "h-full",
      )}
      style={placement === "sheet" ? { width: BOT_RAIL_COLLAPSED_WIDTH } : undefined}
    >
      {placement === "window" ? (
        // The titlebar row: traffic lights on macOS, the sidebar toggle elsewhere.
        <div
          className={cn("h-(--workspace-topbar-height) shrink-0", isElectron && "drag-region")}
        />
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-2 border-r border-sidebar-border pt-0.5 pb-2",
          collapsed && "items-center",
        )}
      >
        {/* The padding sits inside the scroller so it doesn't clip the badges over the top avatar. */}
        <div
          className={cn(
            "flex min-h-0 w-full flex-1 flex-col overflow-y-auto pt-1.5 pb-1 [scrollbar-width:none]",
            collapsed ? "items-center gap-1" : "gap-0.5",
          )}
        >
          {collapsed ? (
            <RailItem
              label="Projects"
              hint="Every project and its threads"
              active={projectsActive}
              signal={null}
              shortcut={null}
              variant="icon"
              onSelect={selectProjects}
            >
              <FoldersIcon className="size-5" strokeWidth={1.75} />
            </RailItem>
          ) : (
            <RailRow
              label="Projects"
              icon={<FoldersIcon />}
              active={projectsActive}
              onSelect={selectProjects}
            />
          )}
          {bots.length === 0 ? null : collapsed ? (
            <RailDivider />
          ) : (
            <div aria-hidden className="mx-4 my-1.5 h-px shrink-0 bg-sidebar-border" />
          )}
          {bots.map((bot, index) =>
            collapsed ? (
              <RailItem
                key={bot.key}
                label={bot.name}
                hint={headquartersHint}
                active={onBots && scopedManager === null && bot.key === active?.key}
                signal={botRailSignal(needsYou.get(bot.key) ?? 0, activity.get(bot.key))}
                shortcut={shortcutFor(botJumpCommandForIndex(index))}
                onSelect={(event) => select(bot, event)}
              >
                <BotAvatar
                  avatar={bot.avatar}
                  color={bot.color}
                  size={36}
                  working={
                    botRailSignal(needsYou.get(bot.key) ?? 0, activity.get(bot.key))?.kind ===
                    "working"
                  }
                />
              </RailItem>
            ) : (
              <BotListRow
                key={bot.key}
                bot={bot}
                active={onBots && scopedManager === null && bot.key === active?.key}
                needsYou={needsYou.get(bot.key) ?? 0}
                activity={activity.get(bot.key)}
                onSelect={(event) => select(bot, event)}
              />
            ),
          )}
          {managers.length === 0 ? null : collapsed ? (
            <RailDivider />
          ) : (
            <h3 className="px-4 pt-4 pb-1 text-2xs text-muted-foreground">Project managers</h3>
          )}
          {managers.map((manager) => {
            const activity = activityForProjects(activityByProject, manager.memberProjectKeys);
            // Primitives, so a merged activity object doesn't defeat the rows' memo.
            const status = {
              needsYou: needsYouForProjects(needsYouByProject, manager.memberProjectKeys),
              failed: activity?.failed === true,
              working: activity?.working === true,
              unread: activity?.unread === true,
            };
            return collapsed ? (
              <ManagerRailItem
                key={manager.key}
                manager={manager}
                {...status}
                active={scopedManager?.key === manager.key}
                onSelect={selectManager}
              />
            ) : (
              <ManagerListRow
                key={manager.key}
                manager={manager}
                {...status}
                active={scopedManager?.key === manager.key}
                onSelect={selectManager}
              />
            );
          })}
        </div>
        <div
          className={cn(
            "flex w-full shrink-0 flex-col",
            collapsed ? "items-center gap-2" : "gap-0.5",
          )}
        >
          {collapsed ? (
            <RailDivider />
          ) : (
            <div aria-hidden className="mx-4 mb-1.5 h-px shrink-0 bg-sidebar-border" />
          )}
          <RailPlaces
            destination={destination}
            collapsed={collapsed}
            managedProjectKeys={new Set(managers.flatMap((manager) => manager.memberProjectKeys))}
          />
          <SidebarUpdatePill placement="rail" collapsed={collapsed} />
          <EnvironmentFilterMenu collapsed={collapsed} />
          <RailAppPages collapsed={collapsed} />
        </div>
      </div>
      {placement === "window" ? <BotRailResizeHandle /> : null}
    </nav>
  );
});

/**
 * The rail's right edge, and the pointer's way to collapse and expand it. Dragging sets the
 * expanded width; under the snap width it shows the icon column's outline and collapses there on
 * release. Double-click expands to the default width.
 */
function BotRailResizeHandle() {
  const setLayout = useUiStateStore((store) => store.setBotRailLayout);
  const {
    ref: handleRef,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
  } = useSnapResizeDrag<HTMLDivElement>((event) => {
    const nav = event.currentTarget.closest<HTMLElement>("nav");
    const wrapper = nav?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!nav || !wrapper) return null;
    const state = useUiStateStore.getState();
    const startWidth = state.botRailCollapsed ? BOT_RAIL_COLLAPSED_WIDTH : state.botRailWidth;
    // The layout writes this property too; it is set here only for the drag, and a committed
    // width reaches it when the store re-renders the layout.
    const setLiveWidth = (width: number) =>
      wrapper.style.setProperty("--sidebar-leading-width", `${width}px`);
    return {
      collapsed: state.botRailCollapsed,
      width: startWidth,
      bounds: { min: BOT_RAIL_COLLAPSED_WIDTH, max: BOT_RAIL_MAX_WIDTH },
      snap: BOT_RAIL_SNAP,
      preview(width, snapping) {
        setLiveWidth(width);
        nav.toggleAttribute("data-snap", snapping);
      },
      restore() {
        nav.removeAttribute("data-snap");
        setLiveWidth(startWidth);
      },
      commit: (width) => setLayout(botRailLayoutAfterDrag(state, width)),
    };
  });
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute top-(--workspace-topbar-height) bottom-2 left-1 z-30 hidden w-12 rounded-xl border border-dashed border-sidebar-foreground/40 group-data-[snap]/rail:block"
      />
      {/* Pointer only; the `bot.inbox` shortcut and the palette's Toggle bot list are the keyboard way. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the bot list"
        className="absolute inset-y-0 -right-[3px] z-30 w-1.5 cursor-col-resize after:absolute after:inset-y-0 after:left-[2px] after:w-[2px] hover:after:bg-primary"
        ref={handleRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onLostPointerCapture}
        onDoubleClick={() =>
          setLayout({ botRailCollapsed: false, botRailWidth: BOT_RAIL_DEFAULT_WIDTH })
        }
      />
    </>
  );
}

const listRowClassName = (active: boolean) =>
  cn(
    "relative mx-2 flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2",
    active ? "bg-sidebar-row-selected" : "hover:bg-sidebar-row-hover",
  );

/** A row's top line: its name, then its time and unread dot. */
function ListRowHead({
  name,
  emphasized,
  time,
  unread,
}: {
  readonly name: string;
  readonly emphasized: boolean;
  readonly time: string | null;
  readonly unread: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm font-medium",
          emphasized ? "text-foreground" : "text-sidebar-foreground",
        )}
      >
        {name}
      </span>
      <span className="flex h-4 min-w-8 shrink-0 items-center justify-end gap-1.5 text-xs text-muted-foreground tabular-nums">
        {unread ? (
          <span aria-hidden className="size-1.5 rounded-full bg-sidebar-foreground" />
        ) : null}
        <RelativeTimeLabel timestamp={time} />
      </span>
    </span>
  );
}

function ListRowPreview({
  mark,
  preview,
}: {
  readonly mark: "needs-you" | "working" | null;
  readonly preview: string;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {mark === "working" ? (
        <span className="size-1.5 shrink-0 rounded-full bg-info">
          <span className="sr-only">Working</span>
        </span>
      ) : mark === "needs-you" ? (
        <span className="shrink-0 rounded-sm bg-warning px-1 text-2xs leading-4 font-semibold text-black">
          Needs input
        </span>
      ) : null}
      <span className="min-w-0 truncate text-xs text-muted-foreground">{preview}</span>
    </span>
  );
}

// Rows take their own counts so one change doesn't make every row rebuild every bot's totals.
const BotListRow = memo(function BotListRow({
  bot,
  active,
  needsYou,
  activity,
  onSelect,
}: {
  readonly bot: LogicalBot;
  readonly active: boolean;
  readonly needsYou: number;
  readonly activity: BotActivity | undefined;
  readonly onSelect: (event: MouseEvent) => void;
}) {
  const connected = useConnectedEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  const member = headquartersMember(bot, connected, environmentFilter);
  const threadId = member ? botHeadquartersThreadId(member.botId) : null;
  const shell = useThreadShell(
    member && threadId ? scopeThreadRef(member.environmentId, threadId) : null,
  );
  const summary = botListRowSummary(needsYou, activity, shell?.source.latestVisibleMessage);
  return (
    <div className={cn(listRowClassName(active), member === undefined && "opacity-60")}>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={[bot.name, summary.mark === "needs-you" ? "needs input" : summary.mark]
          .filter(Boolean)
          .join(", ")}
        className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onSelect}
      />
      <BotAvatar
        avatar={bot.avatar}
        color={bot.color}
        size={40}
        working={summary.mark === "working"}
        className="pointer-events-none shrink-0"
      />
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5">
        <ListRowHead
          name={bot.name}
          emphasized={summary.unread}
          time={summary.time}
          unread={summary.unread}
        />
        <ListRowPreview
          mark={summary.mark}
          preview={member === undefined ? "Offline" : summary.preview}
        />
      </span>
    </div>
  );
});

/** A manager's name in the rail: its project, and the machine it lives on when there are several. */
const managerName = (manager: RailProjectManager) =>
  manager.homeLabel === null ? manager.title : `${manager.title} · ${manager.homeLabel}`;

// Like bot rows, manager rows take their project group's totals from the rail.
interface ManagerRowProps {
  readonly manager: RailProjectManager;
  readonly needsYou: number;
  readonly failed: boolean;
  readonly working: boolean;
  readonly unread: boolean;
  readonly active: boolean;
  readonly onSelect: (manager: RailProjectManager) => void;
}

const ManagerListRow = memo(function ManagerListRow({
  manager,
  needsYou,
  failed,
  working,
  unread,
  active,
  onSelect,
}: ManagerRowProps) {
  const shell = useThreadShell(scopeThreadRef(manager.environmentId, manager.threadId));
  const icon = useProjectManagerIcon(manager.environmentId, manager.projectId);
  const latest = shell?.source.latestVisibleMessage;
  const summary = botListRowSummary(needsYou, { failed, working, unread }, latest);
  const status = summary.mark === "needs-you" ? "needs input" : summary.mark;
  return (
    <div className={listRowClassName(active)}>
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        aria-label={`${manager.title}'s project manager${manager.homeLabel === null ? "" : ` on ${manager.homeLabel}`}${status ? `, ${status}` : ""}`}
        className="absolute inset-0 cursor-pointer rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => onSelect(manager)}
      />
      <ProjectManagerAvatar
        projectId={manager.projectId}
        icon={icon}
        size={40}
        working={summary.mark === "working"}
        className="pointer-events-none shrink-0"
      />
      <span className="pointer-events-none flex min-w-0 flex-1 flex-col gap-0.5">
        <ListRowHead
          name={managerName(manager)}
          emphasized={summary.unread}
          time={summary.time}
          unread={summary.unread}
        />
        <ListRowPreview
          mark={summary.mark}
          preview={latest ? summary.preview : "Project manager"}
        />
      </span>
    </div>
  );
});

const ManagerRailItem = memo(function ManagerRailItem({
  manager,
  needsYou,
  failed,
  working,
  unread,
  active,
  onSelect,
}: ManagerRowProps) {
  const icon = useProjectManagerIcon(manager.environmentId, manager.projectId);
  const signal = botRailSignal(needsYou, { failed, working, unread });
  return (
    <RailItem
      label={managerName(manager)}
      hint="Project manager"
      active={active}
      signal={signal}
      shortcut={null}
      onSelect={() => onSelect(manager)}
    >
      <ProjectManagerAvatar
        projectId={manager.projectId}
        icon={icon}
        size={36}
        working={signal?.kind === "working"}
      />
    </RailItem>
  );
});

/** Bots, automations and pull requests: the places that swap the sidebar's list. */
function RailPlaces({
  destination,
  collapsed,
  managedProjectKeys,
}: {
  readonly destination: ReturnType<typeof useRailDestination>;
  readonly collapsed: boolean;
  readonly managedProjectKeys: ReadonlySet<string>;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const automationFailed = useHasUnseenAutomationFailure();
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const hiddenNeedsYou = useHiddenNeedsYouCount(managedProjectKeys);
  const places = [
    {
      label: "Bots",
      icon: BotIcon,
      active: destination === "bots-list",
      // Asks that no pinned bot or manager shows count here.
      signal: hiddenNeedsYou > 0 ? ({ kind: "needs-you", count: hiddenNeedsYou } as const) : null,
      // Its list shows in the thread list's column, which a closed list would hide.
      onSelect: () => {
        if (!isMobile) setOpen(true);
        if (destination !== "bots-list") void navigate({ to: BOTS_LIST_PATH });
      },
    },
    {
      label: "Automations",
      icon: ClockIcon,
      active: destination === "automations",
      signal: automationFailed ? ({ kind: "failed" } as const) : null,
      // Its list is what the mobile sheet shows next, so the sheet stays open.
      onSelect: () => {
        if (!isMobile) setOpen(true);
        if (destination !== "automations") void navigate({ to: AUTOMATIONS_PATH });
      },
    },
    ...(pullRequestsSupported
      ? [
          {
            label: "Pull requests",
            icon: PullRequestGlyph.pullRequest,
            active: destination === "pull-requests",
            signal: null,
            onSelect: () => {
              if (isMobile) setOpenMobile(false);
              if (destination !== "pull-requests") {
                void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
              }
            },
          },
        ]
      : []),
    ...(issuesSupported
      ? [
          {
            label: "Issues",
            icon: IssueGlyph.issue,
            active: destination === "issues",
            signal: null,
            onSelect: () => {
              if (isMobile) setOpenMobile(false);
              if (destination !== "issues") {
                void navigate({ to: "/issues", search: readIssueListPreferences() });
              }
            },
          },
        ]
      : []),
  ];
  return places.map(({ label, icon: Icon, active, signal, onSelect }) =>
    collapsed ? (
      <RailItem
        key={label}
        label={label}
        hint={null}
        active={active}
        signal={signal}
        shortcut={null}
        variant="icon"
        onSelect={onSelect}
      >
        <Icon className="size-5" strokeWidth={1.75} />
      </RailItem>
    ) : (
      <RailRow
        key={label}
        label={label}
        icon={<Icon />}
        active={active}
        signal={signal}
        onSelect={onSelect}
      />
    ),
  );
}

/** Usage and Settings, which open as modals over whatever the rail points at. */
function RailAppPages({ collapsed }: { readonly collapsed: boolean }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const open = (to: "/usage" | "/settings") => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
  };
  const pages = [
    {
      label: "Usage",
      icon: ChartNoAxesColumnIcon,
      active: pathname === "/usage",
      onSelect: () => open("/usage"),
    },
    {
      label: "Settings",
      icon: SettingsIcon,
      active: pathname === "/settings" || pathname.startsWith("/settings/"),
      onSelect: () => open("/settings"),
    },
  ];
  return pages.map(({ label, icon: Icon, active, onSelect }) =>
    collapsed ? (
      <RailItem
        key={label}
        label={label}
        hint={null}
        active={active}
        signal={null}
        shortcut={null}
        variant="icon"
        onSelect={onSelect}
      >
        <Icon className="size-5" strokeWidth={1.75} />
      </RailItem>
    ) : (
      <RailRow key={label} label={label} icon={<Icon />} active={active} onSelect={onSelect} />
    ),
  );
}

/** An expanded rail's place or page: a 16px icon and its label. */
function RailRow({
  label,
  icon,
  active,
  signal = null,
  onSelect,
}: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly active: boolean;
  readonly signal?: BotRailSignal | null;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={onSelect}
      className={cn(
        "mx-2 flex h-8 min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-start text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
        active
          ? "bg-sidebar-row-selected text-sidebar-foreground"
          : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {signal?.kind === "failed" ? (
        <span aria-label="a run failed" className="size-2 shrink-0 rounded-full bg-error" />
      ) : signal?.kind === "needs-you" ? (
        <span className="shrink-0 rounded-sm bg-warning px-1 text-2xs leading-4 font-semibold text-black tabular-nums">
          {signal.count > 99 ? "99+" : signal.count}
          <span className="sr-only"> need{signal.count === 1 ? "s" : ""} you</span>
        </span>
      ) : null}
    </button>
  );
}

const RailDivider = () => (
  <div aria-hidden className="my-1.5 h-px w-6 shrink-0 rounded-full bg-sidebar-border" />
);

const signalLabel = (signal: BotRailSignal | null): string | null => {
  switch (signal?.kind) {
    case "needs-you":
      return `${signal.count} need${signal.count === 1 ? "s" : ""} you`;
    case "failed":
      return "a run failed";
    case "working":
      return "working";
    case "unread":
      return "unread";
    default:
      return null;
  }
};

/**
 * One collapsed rail entry with one signal: a count when threads wait on you, a red dot for a
 * failed run, a blue dot low on the corner while working (a ring would read as selected), and a
 * neutral dot for an unread run. Bots fade until picked or hovered; `icon`s (the places) pick up
 * a tile on hover and while selected.
 */
const RailItem = memo(function RailItem({
  label,
  hint,
  active,
  signal,
  shortcut,
  variant = "bot",
  onSelect,
  children,
}: {
  readonly label: string;
  readonly hint: string | null;
  readonly active: boolean;
  readonly signal: BotRailSignal | null;
  readonly shortcut: string | null;
  readonly variant?: "bot" | "icon";
  readonly onSelect: (event: MouseEvent) => void;
  readonly children: ReactNode;
}) {
  const status = signalLabel(signal);
  return (
    <div className="group/bot relative flex w-full justify-center">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                "relative flex cursor-pointer flex-col items-center rounded-xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                variant === "bot"
                  ? "w-12 gap-0.5 pb-0.5"
                  : active
                    ? "bg-sidebar-row-hover text-sidebar-foreground"
                    : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
              )}
              aria-pressed={active}
              aria-label={status ? `${label}, ${status}` : label}
              onClick={onSelect}
            />
          }
        >
          <span className="relative flex size-10 items-center justify-center">
            {variant === "bot" ? (
              // The signal stays at full strength on a faded bot.
              <span
                className={cn(
                  "flex transition-[opacity,filter] duration-150",
                  !active &&
                    "opacity-50 saturate-50 group-hover/bot:opacity-100 group-hover/bot:saturate-100",
                )}
              >
                {children}
              </span>
            ) : (
              children
            )}
            {signal?.kind === "needs-you" ? (
              <span
                aria-hidden
                className="absolute -top-1 -right-1.5 h-4 min-w-4 rounded-full bg-warning px-1 text-center text-3xs leading-4 font-semibold text-black tabular-nums ring-2 ring-sidebar"
              >
                {signal.count > 99 ? "99+" : signal.count}
              </span>
            ) : signal?.kind === "failed" || signal?.kind === "unread" ? (
              <span
                aria-hidden
                className={cn(
                  "absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-sidebar",
                  signal.kind === "failed" ? "bg-error" : "bg-sidebar-foreground",
                )}
              />
            ) : signal?.kind === "working" ? (
              <span
                aria-hidden
                className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-info ring-2 ring-sidebar"
              />
            ) : null}
          </span>
          {variant === "bot" ? (
            <span
              aria-hidden
              className={cn(
                "w-full truncate text-center text-3xs",
                active
                  ? "font-semibold text-sidebar-foreground"
                  : "text-sidebar-muted-foreground group-hover/bot:text-sidebar-foreground",
              )}
            >
              {label}
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="right">
          {[label, status].filter(Boolean).join(" · ")}
          {shortcut ? ` (${shortcut})` : ""}
          {hint ? <div className="text-muted-foreground">{hint}</div> : null}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

/** Narrows the rail, sidebar and board to some environments. Shown with two or more. */
function EnvironmentFilterMenu({ collapsed }: { readonly collapsed: boolean }) {
  const connected = useConnectedEnvironmentIds();
  const identities = useEnvironmentIdentities();
  const filter = useEnvironmentFilter();
  const setEnvironmentIds = useUiStateStore((store) => store.setSidebarEnvironmentIds);
  const labelById = new Map(identities.map((identity) => [identity.environmentId, identity.label]));
  if (connected.length < 2) return null;
  const shown = connected.filter((environmentId) => filter === null || filter.has(environmentId));
  const label =
    filter === null
      ? "All environments"
      : shown.length === 1
        ? (labelById.get(shown[0]!) ?? "1 environment")
        : `${shown.length} environments`;
  const toggle = (environmentId: EnvironmentId, checked: boolean) => {
    const next = checked
      ? [...shown, environmentId]
      : shown.filter((candidate) => candidate !== environmentId);
    setEnvironmentIds(next.length >= connected.length ? null : next);
  };
  return (
    <Menu>
      {collapsed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    variant={filter === null ? "ghost-muted" : "secondary"}
                    size="icon-sm"
                    aria-label={`Environments: ${label}`}
                  />
                }
              />
            }
          >
            <ServerIcon />
          </TooltipTrigger>
          <TooltipPopup side="right">{label}</TooltipPopup>
        </Tooltip>
      ) : (
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={`Environments: ${label}`}
              className={cn(
                "mx-2 flex h-8 min-w-0 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-start text-sm outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
                filter === null ? "text-sidebar-muted-foreground" : "text-sidebar-foreground",
              )}
            />
          }
        >
          <ServerIcon />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </MenuTrigger>
      )}
      <MenuPopup side="right" align="end">
        <MenuCheckboxItem
          checked={filter === null}
          closeOnClick={false}
          onCheckedChange={(checked) => {
            if (checked) setEnvironmentIds(null);
          }}
        >
          All environments
        </MenuCheckboxItem>
        <MenuSeparator />
        {connected.map((environmentId) => {
          const checked = shown.includes(environmentId);
          return (
            <MenuCheckboxItem
              key={environmentId}
              checked={checked}
              closeOnClick={false}
              // The last shown environment stays; "All environments" is the way back.
              disabled={checked && shown.length === 1}
              onCheckedChange={(next) => toggle(environmentId, next)}
            >
              {labelById.get(environmentId) ?? environmentId}
            </MenuCheckboxItem>
          );
        })}
      </MenuPopup>
    </Menu>
  );
}
