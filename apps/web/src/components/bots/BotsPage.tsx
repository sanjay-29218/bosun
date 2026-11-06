import { useAtomValue } from "@effect/atom-react";
import { botAutomationsDeleteWarning } from "@t3tools/client-runtime/state/automations";
import { logicalBotProjectLists } from "@t3tools/client-runtime/state/bot-rail";
import { logicalBotKey, type Bot, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
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
  useShownBotEnvironmentIds,
} from "../../state/botRail";
import { useProjects } from "../../state/entities";
import { useEnvironmentIdentities } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { LibraryFrame } from "../library/LibraryFrame";
import { useEnvironmentDefaultModel } from "../library/RoleEditor";
import { BOTS_PATH } from "../sidebar/mainAppLocation";
import { useOpenBotHeadquarters } from "../sidebar/openBotHeadquarters";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { BotEditor } from "./BotEditor";
import { BotProjectList } from "./BotProjects";
import { botDeleteBlocker, groupProjectsByBot, moveBotInOrder } from "./bots.logic";
import type { BotsSearch } from "./botsSearch";

/** The Bots destination's main pane: the selected bot's editor, or a new one. */
export function BotsPage(search: BotsSearch) {
  const navigate = useNavigate();
  const environmentIds = useShownBotEnvironmentIds();
  const environmentId = search.environmentId ?? (search.new ? (environmentIds[0] ?? null) : null);

  if (environmentId !== null && (search.new || search.botId !== undefined)) {
    return (
      <EnvironmentBotPage
        // A new bot's form starts over on each environment.
        key={search.new ? `new:${environmentId}` : environmentId}
        environmentId={environmentId}
        botId={search.botId ?? null}
      />
    );
  }
  return (
    <LibraryFrame root="Bots" title={null} actions={null}>
      <WorkspacePageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>
              {environmentIds.length === 0 ? "No environment runs bots" : "Pick a bot"}
            </EmptyTitle>
            <EmptyDescription>
              {environmentIds.length === 0
                ? "Connect an environment that runs bots to add and edit them here."
                : "Each bot owns projects and runs their work with the model, access and tools you give it."}
            </EmptyDescription>
          </EmptyHeader>
          {environmentIds.length > 0 ? (
            <Button
              size="sm"
              onClick={() => void navigate({ to: BOTS_PATH, search: { new: true } })}
            >
              <PlusIcon />
              New bot
            </Button>
          ) : null}
        </Empty>
      </WorkspacePageContainer>
    </LibraryFrame>
  );
}

function EnvironmentBotPage({
  environmentId,
  botId,
}: {
  readonly environmentId: EnvironmentId;
  readonly botId: string | null;
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
  const bot = botId === null ? null : (bots.find((candidate) => candidate.id === botId) ?? null);
  const open = (id: string | null) =>
    void navigate({
      to: BOTS_PATH,
      search: id === null ? {} : { environmentId, botId: id },
      replace: id !== null,
    });

  if (!botsQuery.data || (botId !== null && bot === null)) {
    return (
      <LibraryFrame root="Bots" title={null} actions={null}>
        <WorkspacePageContainer>
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
        </WorkspacePageContainer>
      </LibraryFrame>
    );
  }

  const ownedProjects = bot ? (groupProjectsByBot(projects).get(bot.id) ?? []) : [];
  // The same bot on other environments; one the rail hasn't merged yet stands alone.
  const logicalBot = bot
    ? (logicalBots.find((candidate) =>
        candidate.members.some(
          (member) => member.environmentId === environmentId && member.botId === bot.id,
        ),
      ) ?? {
        key: logicalBotKey(bot),
        name: bot.name,
        avatar: bot.avatar,
        color: bot.color,
        members: [{ environmentId, botId: bot.id }],
      })
    : null;
  const projectLists = logicalBot
    ? logicalBotProjectLists(
        logicalBot,
        logicalBots.includes(logicalBot) ? logicalBots : [...logicalBots, logicalBot],
        allProjects,
        botEnvironmentIds,
      )
    : null;
  return (
    <LibraryFrame
      root="Bots"
      title={bot?.name ?? "New bot"}
      actions={
        bot ? (
          <BotActions
            environmentId={environmentId}
            bot={bot}
            bots={bots}
            ownedProjects={ownedProjects.length}
            onDeleted={() => open(null)}
          />
        ) : null
      }
    >
      <WorkspacePageContainer>
        <BotEditor
          key={`${environmentId}:${bot?.id ?? "new"}:${formRevision}`}
          environmentId={environmentId}
          bot={bot}
          defaultModel={defaultModel}
          usedAvatars={bots.map((candidate) => candidate.avatar)}
          projectCount={projectLists?.owned.length ?? 0}
          projects={
            logicalBot && projectLists ? (
              <BotProjectList
                environmentId={environmentId}
                bot={logicalBot}
                bots={logicalBots.includes(logicalBot) ? logicalBots : [...logicalBots, logicalBot]}
                ownedProjects={projectLists.owned}
                availableProjects={projectLists.available}
                projectsWithoutBots={projectLists.withoutBots}
                environmentLabels={environmentLabels}
              />
            ) : null
          }
          onConflict={botsQuery.refresh}
          onSaved={(id) => {
            if (id !== bot?.id) open(id);
          }}
          onCancel={() => (bot ? setFormRevision((revision) => revision + 1) : open(null))}
        />
      </WorkspacePageContainer>
    </LibraryFrame>
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
