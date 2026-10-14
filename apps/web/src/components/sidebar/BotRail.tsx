import { useAtomValue } from "@effect/atom-react";
import { logicalBotKey, type LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon, ServerIcon, SettingsIcon } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { isElectron } from "../../env";
import { botJumpCommandForIndex, botJumpIndexFromCommand } from "../../keybindings";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../../keybindings";
import { cn } from "../../lib/utils";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { botsEnvironment } from "../../state/bots";
import {
  useBotEnvironmentIds,
  useEnvironmentFilter,
  useNeedsYouByLogicalBot,
  useSelectLogicalBot,
  useVisibleActiveLogicalBot,
  useVisibleLogicalBots,
} from "../../state/botRail";
import { useConnectedEnvironmentIds, useEnvironmentIdentities } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { AddBotDialog } from "../settings/BotsSettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuCheckboxItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useSwitchBotMainView } from "./mainAppLocation";

/** The rail's width; the sidebar sits right of it. */
export const BOT_RAIL_WIDTH = "3.5rem";

/**
 * The bot rail: a column of bots left of the sidebar. Picking one narrows the sidebar,
 * board and Needs you to that bot's projects. `window` pins it to the window's left edge
 * under the titlebar; `sheet` puts it inside the mobile sidebar sheet.
 */
export const BotRail = memo(function BotRail({
  placement,
}: {
  readonly placement: "window" | "sheet";
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const bots = useVisibleLogicalBots();
  const active = useVisibleActiveLogicalBot();
  const needsYou = useNeedsYouByLogicalBot();
  const selectBot = useSelectLogicalBot();
  const switchBotMainView = useSwitchBotMainView();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const botEnvironmentIds = useBotEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  const [addingOn, setAddingOn] = useState<EnvironmentId | null>(null);
  const multipleBots = bots.length > 1;

  // New bots go to the first connected, shown environment with bots, primary first.
  const connectedEnvironmentIds = useConnectedEnvironmentIds();
  const addEnvironmentId =
    botEnvironmentIds.find(
      (environmentId) =>
        connectedEnvironmentIds.includes(environmentId) &&
        (environmentFilter === null || environmentFilter.has(environmentId)),
    ) ?? null;
  const canAdd = useAtomValue(botsEnvironment.create.permissionAtom(addEnvironmentId));

  const select = (bot: LogicalBot) => {
    if (bot.key !== active?.key) switchBotMainView(() => selectBot(bot));
  };

  // Mod+1-9 switches bots while there are several (thread jumps then use Ctrl+Mod+1-9).
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
      const bot = index === null ? undefined : bots[index];
      if (!bot) return;
      event.preventDefault();
      event.stopPropagation();
      if (bot.key !== active?.key) switchBotMainView(() => selectBot(bot));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active?.key, bots, keybindings, multipleBots, selectBot, switchBotMainView]);

  const openBotSettings = () => {
    if (isMobile) setOpenMobile(false);
    const environmentId = active?.members[0]?.environmentId ?? addEnvironmentId;
    void navigate({
      to: "/settings/bots",
      ...(environmentId ? { search: { machine: environmentId } } : {}),
    });
  };

  return (
    <nav
      aria-label="Bots"
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
      <div className="flex min-h-0 flex-1 flex-col items-center gap-1.5 border-r border-sidebar-border py-2">
        <div className="flex min-h-0 flex-col items-center gap-1.5 overflow-y-auto scrollbar-gutter-both">
          {bots.map((bot, index) => (
            <BotRailItem
              key={bot.key}
              bot={bot}
              active={bot.key === active?.key}
              needsYou={needsYou.get(bot.key) ?? 0}
              shortcut={
                multipleBots
                  ? shortcutLabelForCommand(keybindings, botJumpCommandForIndex(index), {
                      context: { multipleBots },
                    })
                  : null
              }
              onSelect={() => select(bot)}
            />
          ))}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Add bot"
                  disabled={addEnvironmentId === null || !canAdd}
                  onClick={() => setAddingOn(addEnvironmentId)}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="right">Add bot</TooltipPopup>
          </Tooltip>
        </div>
        <div className="mt-auto flex flex-col items-center gap-1.5">
          <EnvironmentFilterMenu />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-lg"
                  aria-label="Bot settings"
                  onClick={openBotSettings}
                />
              }
            >
              <SettingsIcon />
            </TooltipTrigger>
            <TooltipPopup side="right">Bot settings</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {addingOn ? (
        <AddBotDialog
          environmentId={addingOn}
          onClose={() => setAddingOn(null)}
          onCreated={(bot) =>
            switchBotMainView(() =>
              selectBot({
                key: logicalBotKey(bot),
                name: bot.name,
                emoji: bot.emoji,
                members: [{ environmentId: addingOn, botId: bot.id }],
              }),
            )
          }
        />
      ) : null}
    </nav>
  );
});

const BotRailItem = memo(function BotRailItem({
  bot,
  active,
  needsYou,
  shortcut,
  onSelect,
}: {
  readonly bot: LogicalBot;
  readonly active: boolean;
  readonly needsYou: number;
  readonly shortcut: string | null;
  readonly onSelect: () => void;
}) {
  const waiting = needsYou > 0 ? `${needsYou} need${needsYou === 1 ? "s" : ""} you` : null;
  return (
    <div className="relative">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={active ? "secondary" : "ghost"}
              size="icon-lg"
              aria-pressed={active}
              aria-label={waiting ? `${bot.name}, ${waiting}` : bot.name}
              onClick={onSelect}
            />
          }
        >
          <span aria-hidden className="text-lg leading-none">
            {bot.emoji}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="right">
          {[bot.name, waiting].filter(Boolean).join(" · ")}
          {shortcut ? ` (${shortcut})` : ""}
        </TooltipPopup>
      </Tooltip>
      {needsYou > 0 ? (
        <span aria-hidden className="pointer-events-none absolute -right-1 -top-1">
          <Badge variant="warning" size="sm">
            {needsYou > 99 ? "99+" : needsYou}
          </Badge>
        </span>
      ) : null}
    </div>
  );
});

/** Narrows the rail, sidebar and board to some environments. Shown with two or more. */
function EnvironmentFilterMenu() {
  const connected = useConnectedEnvironmentIds();
  const identities = useEnvironmentIdentities();
  const filter = useEnvironmentFilter();
  const setEnvironmentIds = useUiStateStore((store) => store.setSidebarEnvironmentIds);
  const labelById = useMemo(
    () => new Map(identities.map((identity) => [identity.environmentId, identity.label])),
    [identities],
  );
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
                  variant={filter === null ? "ghost" : "secondary"}
                  size="icon-lg"
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
