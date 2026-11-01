import { useAtomValue } from "@effect/atom-react";
import {
  botRailSignal,
  type BotRailSignal,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  ChartNoAxesColumnIcon,
  ClockIcon,
  LayersIcon,
  ServerIcon,
  SettingsIcon,
  UsersRoundIcon,
} from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { memo, useEffect, type ReactNode } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { botJumpCommandForIndex, botJumpIndexFromCommand } from "../../keybindings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { useHasUnseenAutomationFailure } from "../../state/automations";
import {
  useActivityByLogicalBot,
  useEnvironmentFilter,
  useNeedsYouByLogicalBot,
  useSelectLogicalBot,
  useVisibleActiveLogicalBot,
  useVisibleLogicalBots,
} from "../../state/botRail";
import {
  useConnectedEnvironmentIds,
  useEnvironmentIdentities,
  usePullRequestsSupported,
} from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { BotAvatar } from "../BotAvatar";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  AUTOMATIONS_PATH,
  BOTS_PATH,
  isSidebarUtilityPage,
  LIBRARY_PATH,
  useRailDestination,
  useSwitchBotMainView,
} from "./mainAppLocation";
import { useOpenBotHeadquarters } from "./openBotHeadquarters";
import { SidebarUpdatePill } from "./SidebarUpdatePill";

/** The rail's width; the sidebar sits right of it. */
export const BOT_RAIL_WIDTH = "3.5rem";

/**
 * The bot rail: All bots and the bots, then its places, then Usage, Settings and app updates.
 * A bot narrows the sidebar, board and Needs you to its projects; a place swaps the sidebar's
 * list. `window` pins it to the window's left edge under the titlebar; `sheet` puts it in the
 * mobile sheet.
 */
export const BotRail = memo(function BotRail({
  placement,
}: {
  readonly placement: "window" | "sheet";
}) {
  const { isMobile, setOpenMobile } = useSidebar();
  const bots = useVisibleLogicalBots();
  const active = useVisibleActiveLogicalBot();
  const needsYou = useNeedsYouByLogicalBot();
  const activity = useActivityByLogicalBot();
  const selectBot = useSelectLogicalBot();
  const switchBotMainView = useSwitchBotMainView();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const multipleBots = bots.length > 1;

  const openHeadquarters = useOpenBotHeadquarters();
  const destination = useRailDestination();
  const onBots = destination === "bots";
  const onUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  // Null is All bots. Switching saves and restores List / Board per selection.
  const switchTo = (bot: LogicalBot | null) => {
    if ((bot?.key ?? null) !== (active?.key ?? null) || onUtilityPage) {
      switchBotMainView(() => selectBot(bot));
      return true;
    }
    return false;
  };
  // Picking a bot shows its threads; picking it again there opens its headquarters.
  const select = (bot: LogicalBot) => {
    if (switchTo(bot)) return;
    if (isMobile) setOpenMobile(false);
    openHeadquarters(bot);
  };

  // Mod+1-9 switches bots while there are several (thread jumps then use Ctrl+Mod+1-9).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a window keydown listener for the bot jump shortcuts, removed on unmount.
  useEffect(() => {
    if (!multipleBots) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen() || isModelPickerOpen()) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: isTerminalFocused(), multipleBots },
      });
      const index = botJumpIndexFromCommand(command ?? "");
      const bot = command === "bot.inbox" ? null : index === null ? undefined : bots[index];
      if (bot === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      switchTo(bot);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, multipleBots, switchTo, bots]);

  const shortcutFor = (command: Parameters<typeof shortcutLabelForCommand>[1]) =>
    multipleBots
      ? shortcutLabelForCommand(keybindings, command, { context: { multipleBots } })
      : null;

  return (
    <nav
      aria-label="Bots"
      // Takes the sidebar's palette so every theme paints the rail and sidebar as one surface.
      data-app-sidebar=""
      className={cn(
        "flex w-(--sidebar-leading-width) shrink-0 flex-col bg-sidebar surface-grain text-sidebar-foreground",
        placement === "window" ? "relative z-20 hidden md:flex" : "h-full",
      )}
      style={placement === "sheet" ? { width: BOT_RAIL_WIDTH } : undefined}
    >
      {placement === "window" ? (
        // The titlebar row: traffic lights on macOS, the sidebar toggle elsewhere.
        <div
          className={cn("h-(--workspace-topbar-height) shrink-0", isElectron && "drag-region")}
        />
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col items-center gap-2 border-r border-sidebar-border py-2">
        <div className="flex min-h-0 w-full flex-col items-center gap-2 overflow-y-auto scrollbar-gutter-both">
          {/* All bots is hidden for now; the palette's Show All bots and bot.inbox still reach it. */}
          {bots.map((bot, index) => (
            <RailItem
              key={bot.key}
              label={bot.name}
              hint={bot.key === active?.key ? "Click to open its thread" : null}
              active={onBots && bot.key === active?.key}
              signal={botRailSignal(needsYou.get(bot.key) ?? 0, activity.get(bot.key))}
              shortcut={shortcutFor(botJumpCommandForIndex(index))}
              onSelect={() => select(bot)}
            >
              <BotAvatar avatar={bot.avatar} color={bot.color} size={32} shaded={false} />
            </RailItem>
          ))}
        </div>
        <RailDivider />
        <RailPlaces destination={destination} />
        <div className="mt-auto flex w-full flex-col items-center gap-2">
          <EnvironmentFilterMenu />
          <RailAppPages />
          <SidebarUpdatePill placement="rail" />
        </div>
      </div>
    </nav>
  );
});

/**
 * Bots (where bots are added and edited), then Automations, Library and pull requests:
 * monochrome icons that swap the sidebar's list.
 */
function RailPlaces({
  destination,
}: {
  readonly destination: ReturnType<typeof useRailDestination>;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const automationFailed = useHasUnseenAutomationFailure();
  const pullRequestsSupported = usePullRequestsSupported();
  // Automations and Library keep the mobile sheet open, since their list is what it shows next.
  const leaveSheet = () => {
    if (isMobile) setOpenMobile(false);
  };
  return (
    <>
      <RailItem
        label="Bots"
        hint="Add and edit bots"
        active={destination === "bot-list"}
        signal={null}
        shortcut={null}
        variant="icon"
        onSelect={() => {
          if (destination !== "bot-list") void navigate({ to: BOTS_PATH });
        }}
      >
        <UsersRoundIcon className="size-5" strokeWidth={1.75} />
      </RailItem>
      <RailItem
        label="Automations"
        hint={null}
        active={destination === "automations"}
        signal={automationFailed ? { kind: "failed" } : null}
        shortcut={null}
        variant="icon"
        onSelect={() => {
          if (destination !== "automations") void navigate({ to: AUTOMATIONS_PATH });
        }}
      >
        <ClockIcon className="size-5" strokeWidth={1.75} />
      </RailItem>
      <RailItem
        label="Library"
        hint={null}
        active={destination === "library"}
        signal={null}
        shortcut={null}
        variant="icon"
        onSelect={() => {
          if (destination !== "library") void navigate({ to: LIBRARY_PATH });
        }}
      >
        <LayersIcon className="size-5" strokeWidth={1.75} />
      </RailItem>
      {pullRequestsSupported ? (
        <RailItem
          label="Pull requests"
          hint={null}
          active={destination === "pull-requests"}
          signal={null}
          shortcut={null}
          variant="icon"
          onSelect={() => {
            leaveSheet();
            if (destination !== "pull-requests") {
              void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() });
            }
          }}
        >
          <PullRequestGlyph.pullRequest className="size-5" strokeWidth={1.75} />
        </RailItem>
      ) : null}
    </>
  );
}

/** Usage and Settings, which open as modals over whatever the rail points at. */
function RailAppPages() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const open = (to: "/usage" | "/settings") => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to });
  };
  return (
    <>
      <RailItem
        label="Usage"
        hint={null}
        active={pathname === "/usage"}
        signal={null}
        shortcut={null}
        variant="icon"
        onSelect={() => open("/usage")}
      >
        <ChartNoAxesColumnIcon className="size-5" strokeWidth={1.75} />
      </RailItem>
      <RailItem
        label="Settings"
        hint={null}
        active={pathname === "/settings" || pathname.startsWith("/settings/")}
        signal={null}
        shortcut={null}
        variant="icon"
        onSelect={() => open("/settings")}
      >
        <SettingsIcon className="size-5" strokeWidth={1.75} />
      </RailItem>
    </>
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
 * One rail entry with one signal: a count when threads wait on you, a red dot for a failed
 * run, a blue dot low on the corner while working (a ring would read as selected), and a
 * neutral dot for an unread run. Bots fade until picked or hovered; `icon`s (All bots and
 * the places) pick up a tile on hover and while selected.
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
  readonly onSelect: () => void;
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
                "relative flex size-9 cursor-pointer items-center justify-center rounded-xl outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                variant === "bot"
                  ? undefined
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
              className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-info ring-2 ring-sidebar"
            />
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
function EnvironmentFilterMenu() {
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
