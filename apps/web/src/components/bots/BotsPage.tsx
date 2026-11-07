import { useAtomValue } from "@effect/atom-react";
import { botAutomationsDeleteWarning } from "@t3tools/client-runtime/state/automations";
import { logicalBotProjectLists } from "@t3tools/client-runtime/state/bot-rail";
import { logicalBotKey, type Bot, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentScheduledTasks } from "../../state/automations";
import { botsEnvironment } from "../../state/bots";
import {
  logicalBotsAtom,
  useBotEnvironmentIds,
  useSelectLogicalBot,
  useShownBotEnvironmentIds,
} from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentDefaultModel } from "../library/RoleEditor";
import { CrewSettingsFrame } from "../settings/CrewSettingsFrame";
import { BOTS_SETTINGS_PATH } from "../sidebar/mainAppLocation";
import { useOpenBotHeadquarters } from "../sidebar/openBotHeadquarters";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { BotEditor } from "./BotEditor";
import { BotList } from "./BotList";
import { BotProjectList } from "./BotProjects";
import { botDeleteBlocker, groupProjectsByBot, moveBotInOrder } from "./bots.logic";
import type { BotsSearch } from "./botsSearch";
import { NewBotDialog } from "./NewBotDialog";

/**
 * Settings → Bots: every bot, or one bot's editor. `new` opens the New bot dialog, whose bot
 * opens in its headquarters once made.
 */
export function BotsPage(search: BotsSearch) {
  const navigate = useNavigate();
  const environmentIds = useShownBotEnvironmentIds();
  const selectBot = useSelectLogicalBot();
  const openHeadquarters = useOpenBotHeadquarters();
  const newEnvironmentId = search.new ? (search.environmentId ?? environmentIds[0] ?? null) : null;
  const usedAvatars =
    useEnvironmentQuery(
      newEnvironmentId === null
        ? null
        : botsEnvironment.list({ environmentId: newEnvironmentId, input: {} }),
    ).data?.map((bot) => bot.avatar) ?? [];
  const openNew = (environmentId: EnvironmentId) =>
    void navigate({ to: BOTS_SETTINGS_PATH, search: { environmentId, new: true } });
  const closeNew = () => void navigate({ to: BOTS_SETTINGS_PATH, search: {}, replace: true });

  if (search.environmentId !== undefined && search.botId !== undefined) {
    return (
      <EnvironmentBotPage
        key={search.environmentId}
        environmentId={search.environmentId}
        botId={search.botId}
      />
    );
  }
  const firstEnvironmentId = environmentIds[0];
  return (
    <CrewSettingsFrame
      back={null}
      title="Bots"
      actions={
        <Button
          size="sm"
          disabled={firstEnvironmentId === undefined}
          onClick={() => {
            if (firstEnvironmentId !== undefined) openNew(firstEnvironmentId);
          }}
        >
          <PlusIcon />
          Add bot
        </Button>
      }
    >
      <BotList onNew={openNew} />
      {newEnvironmentId === null ? null : (
        <NewBotDialog
          environmentId={newEnvironmentId}
          usedAvatars={usedAvatars}
          open
          onOpenChange={(open) => {
            if (!open) closeNew();
          }}
          onCreated={(bot) => {
            closeNew();
            const logicalBot = {
              key: logicalBotKey(bot),
              name: bot.name,
              avatar: bot.avatar,
              color: bot.color,
              members: [{ environmentId: newEnvironmentId, botId: bot.id }],
            };
            selectBot(logicalBot);
            openHeadquarters(logicalBot);
            toastManager.add({
              type: "success",
              title: `${bot.name} is ready`,
              actionProps: {
                children: "Edit settings",
                onClick: () =>
                  void navigate({
                    to: BOTS_SETTINGS_PATH,
                    search: { environmentId: newEnvironmentId, botId: bot.id },
                  }),
              },
            });
          }}
        />
      )}
    </CrewSettingsFrame>
  );
}

function EnvironmentBotPage({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
}) {
  const navigate = useNavigate();
  const botsQuery = useEnvironmentQuery(botsEnvironment.list({ environmentId, input: {} }));
  const defaultModel = useEnvironmentDefaultModel(environmentId);
  // Scratch belongs to no bot's work; bots' homes are already left out of the list.
  const allProjects = useProjects()
    .filter((project) => project.isScratch !== true)
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const logicalBots = useAtomValue(logicalBotsAtom);
  const botEnvironmentIds = new Set(useBotEnvironmentIds());
  const environmentLabels = new Map(
    useEnvironmentIdentities().map((environment) => [environment.environmentId, environment.label]),
  );
  // Bumped to remount the form, which discards its draft.
  const [formRevision, setFormRevision] = useState(0);
  const bots = botsQuery.data ?? [];
  const bot = bots.find((candidate) => candidate.id === botId) ?? null;
  const back = {
    label: "Bots",
    onBack: () => void navigate({ to: BOTS_SETTINGS_PATH, search: {} }),
  };

  if (bot === null) {
    return (
      <CrewSettingsFrame back={back} title="Bot" actions={null}>
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {botsQuery.error
                ? "Could not load bots"
                : !botsQuery.data
                  ? "Loading bots…"
                  : "Bot unavailable"}
            </EmptyTitle>
            <EmptyDescription>
              {botsQuery.error ?? (botsQuery.data ? "This bot no longer exists." : null)}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CrewSettingsFrame>
    );
  }

  const ownedProjects = groupProjectsByBot(projects).get(bot.id) ?? [];
  // The same bot on other environments; one the rail hasn't merged yet stands alone.
  const logicalBot = logicalBots.find((candidate) =>
    candidate.members.some(
      (member) => member.environmentId === environmentId && member.botId === bot.id,
    ),
  ) ?? {
    key: logicalBotKey(bot),
    name: bot.name,
    avatar: bot.avatar,
    color: bot.color,
    members: [{ environmentId, botId: bot.id }],
  };
  const railBots = logicalBots.includes(logicalBot) ? logicalBots : [...logicalBots, logicalBot];
  const projectLists = logicalBotProjectLists(logicalBot, railBots, allProjects, botEnvironmentIds);
  return (
    <CrewSettingsFrame
      back={back}
      title={bot.name}
      actions={
        <BotActions
          environmentId={environmentId}
          bot={bot}
          bots={bots}
          ownedProjects={ownedProjects.length}
          onDeleted={back.onBack}
        />
      }
    >
      <BotEditor
        key={`${environmentId}:${bot.id}:${formRevision}`}
        environmentId={environmentId}
        bot={bot}
        defaultModel={defaultModel}
        usedAvatars={bots.map((candidate) => candidate.avatar)}
        projectCount={projectLists.owned.length}
        projects={
          <BotProjectList
            environmentId={environmentId}
            bot={logicalBot}
            bots={railBots}
            ownedProjects={projectLists.owned}
            availableProjects={projectLists.available}
            projectsWithoutBots={projectLists.withoutBots}
            environmentLabels={environmentLabels}
          />
        }
        onConflict={botsQuery.refresh}
        onSaved={() => {}}
        onCancel={() => setFormRevision((revision) => revision + 1)}
      />
    </CrewSettingsFrame>
  );
}

/** Open the bot's headquarters, and its order and deletion. */
function BotActions({
  environmentId,
  bot,
  bots,
  ownedProjects,
  onDeleted,
}: {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
  readonly bots: ReadonlyArray<Bot>;
  readonly ownedProjects: number;
  readonly onDeleted: () => void;
}) {
  const canEdit = useAtomValue(botsEnvironment.update.permissionAtom(environmentId));
  const reorder = useAtomCommand(botsEnvironment.reorder);
  const remove = useAtomCommand(botsEnvironment.delete);
  const scheduledTasks = useEnvironmentScheduledTasks(environmentId);
  const openHeadquarters = useOpenBotHeadquarters();
  const [busy, setBusy] = useState(false);
  const botIds = bots.map((candidate) => candidate.id);
  const deleteBlocker = botDeleteBlocker(bot.id, ownedProjects);

  const move = async (offset: -1 | 1) => {
    const next = moveBotInOrder(botIds, bot.id, offset);
    if (!next) return;
    setBusy(true);
    const result = await reorder({ environmentId, input: { botIds: next } });
    if (result._tag !== "Success")
      toastManager.add({
        type: "error",
        title: `Could not move ${bot.name}`,
        description: formatEnvironmentQueryError(result.cause),
      });
    setBusy(false);
  };

  const deleteBot = async () => {
    // The server deletes the automations that run as the bot along with it.
    const warning = botAutomationsDeleteWarning(scheduledTasks ?? [], bot.id);
    const confirmed = await requestConfirmDialog(
      `Delete ${bot.name}?${warning === null ? "" : ` ${warning}`}\nRuns it already started keep going; it gets no new work.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    setBusy(true);
    const result = await remove({ environmentId, input: { id: bot.id } });
    setBusy(false);
    if (result._tag === "Success") {
      onDeleted();
      return;
    }
    toastManager.add({
      type: "error",
      title: `Could not delete ${bot.name}`,
      description: formatEnvironmentQueryError(result.cause),
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="xs"
        variant="outline"
        onClick={() =>
          openHeadquarters({
            key: logicalBotKey(bot),
            name: bot.name,
            avatar: bot.avatar,
            color: bot.color,
            members: [{ environmentId, botId: bot.id }],
          })
        }
      >
        <MessageSquareIcon />
        Open thread
      </Button>
      <Menu>
        <MenuTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={busy || !canEdit}
              aria-label={`Actions for ${bot.name}`}
            />
          }
        >
          <MoreHorizontalIcon />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem disabled={botIds[0] === bot.id} onClick={() => void move(-1)}>
            <ArrowUpIcon />
            Move up
          </MenuItem>
          <MenuItem disabled={botIds.at(-1) === bot.id} onClick={() => void move(1)}>
            <ArrowDownIcon />
            Move down
          </MenuItem>
          <MenuItem
            variant="destructive"
            disabled={deleteBlocker !== null}
            onClick={() => void deleteBot()}
          >
            <Trash2Icon />
            <span className="flex flex-col">
              Delete
              {/* A disabled item can't show a tooltip, so the reason sits under it. */}
              {deleteBlocker ? (
                <span className="text-xs text-muted-foreground">{deleteBlocker}</span>
              ) : null}
            </span>
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
