import {
  createProjectOwnerResolver,
  logicalBotHome,
  logicalBotWorksOn,
  projectOwner,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import type {
  ContextMenuItem,
  EnvironmentId,
  ProjectId,
  ProjectRemoteBot,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";

import { botsEnvironment } from "../../state/bots";
import { logicalBotsAtom, useBotEnvironmentIds } from "../../state/botRail";
import { useEnvironmentIdentities } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export interface MoveProjectMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly botId?: string | null | undefined;
  readonly remoteBot?: ProjectRemoteBot | null | undefined;
  /** Names the checkout when a project lives on several environments. */
  readonly environmentLabel: string | null;
}

const MOVE_PREFIX = "move-to-bot:";
// The menu's "No bot" entry; logical bot keys are never empty.
const NO_BOT_KEY = "";

/**
 * "Move to bot" for a project's context menu: on each checkout's environment that runs bots, every
 * bot under its home once there are several, the owner checked and bots not allowed there
 * disabled. Several checkouts get a submenu each. Null when there is nowhere to move it.
 */
export function buildMoveToBotMenuItem(
  members: ReadonlyArray<MoveProjectMember>,
  bots: ReadonlyArray<LogicalBot>,
  botEnvironmentIds: ReadonlySet<EnvironmentId>,
  environmentLabels: ReadonlyMap<EnvironmentId, string> = new Map(),
): ContextMenuItem<string> | null {
  const ownerOf = createProjectOwnerResolver(bots);
  const labelOf = (environmentId: EnvironmentId) =>
    environmentLabels.get(environmentId) ?? environmentId;
  const homes = [...new Set(bots.map(logicalBotHome))];
  const botItems = (member: MoveProjectMember): ContextMenuItem<string>[] => {
    if (!botEnvironmentIds.has(member.environmentId)) return [];
    const owner = ownerOf(member);
    const id = (key: string) =>
      `${MOVE_PREFIX}${JSON.stringify([member.environmentId, member.id, key])}`;
    const botItem = (bot: LogicalBot): ContextMenuItem<string> => {
      if (bot.key === owner)
        return { id: id(bot.key), label: bot.name, checked: true, disabled: true };
      return logicalBotWorksOn(bot, member.environmentId)
        ? { id: id(bot.key), label: bot.name }
        : {
            id: id(bot.key),
            label: bot.name,
            disabled: true,
            detail: `Not allowed on ${labelOf(member.environmentId)}`,
          };
    };
    const ordered = [
      ...homes.filter((home) => home === member.environmentId),
      ...homes
        .filter((home) => home !== member.environmentId)
        .toSorted((left, right) => labelOf(left).localeCompare(labelOf(right))),
    ];
    const grouped =
      homes.length <= 1
        ? bots.map(botItem)
        : ordered.flatMap((home) => [
            {
              id: `${MOVE_PREFIX}home:${member.environmentId}:${home}`,
              label: labelOf(home),
              header: true,
            },
            ...bots.filter((bot) => logicalBotHome(bot) === home).map(botItem),
          ]);
    return [
      ...grouped,
      {
        id: id(NO_BOT_KEY),
        label: "No bot",
        ...(projectOwner(member) === null ? { checked: true, disabled: true } : {}),
        separatorBefore: true,
      },
    ];
  };
  const perMember = members
    .map((member) => ({ member, items: botItems(member) }))
    .filter(({ items }) => items.length > 1);
  if (perMember.length === 0) return null;
  if (members.length === 1) {
    return { id: `${MOVE_PREFIX}menu`, label: "Move to bot", children: perMember[0]!.items };
  }
  return {
    id: `${MOVE_PREFIX}menu`,
    label: "Move to bot",
    children: perMember.map(({ member, items }) => ({
      id: `${MOVE_PREFIX}menu:${member.environmentId}`,
      label: member.environmentLabel ?? member.title,
      children: items,
    })),
  };
}

export function parseMoveToBotMenuId(
  id: string,
): { environmentId: EnvironmentId; projectId: ProjectId; botKey: string } | null {
  if (
    !id.startsWith(MOVE_PREFIX) ||
    id.startsWith(`${MOVE_PREFIX}menu`) ||
    id.startsWith(`${MOVE_PREFIX}home:`)
  )
    return null;
  try {
    const [environmentId, projectId, botKey] = JSON.parse(id.slice(MOVE_PREFIX.length)) as [
      EnvironmentId,
      ProjectId,
      string,
    ];
    return { environmentId, projectId, botKey };
  } catch {
    return null;
  }
}

/**
 * Gives a project to a rail entry's bot, or to none. A bot from another environment owns it
 * there as its `remoteBot`, and works on it over the link. Returns an error description, or null
 * once moved.
 */
export function useMoveProjectToLogicalBot() {
  const moveProject = useAtomCommand(botsEnvironment.moveProject, { reportFailure: false });
  const labels = new Map(
    useEnvironmentIdentities().map((environment) => [environment.environmentId, environment.label]),
  );
  return async (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    bot: LogicalBot | null,
  ): Promise<string | null> => {
    const home = bot === null ? null : bot.members[0]!;
    const moved = await moveProject({
      environmentId: project.environmentId,
      input:
        home === null
          ? { projectId: project.id, botId: null }
          : home.environmentId === project.environmentId
            ? { projectId: project.id, botId: home.botId }
            : {
                projectId: project.id,
                botId: home.botId,
                remoteBot: {
                  environmentId: home.environmentId,
                  botId: home.botId,
                  name: bot!.name,
                  homeLabel: labels.get(home.environmentId) ?? home.environmentId,
                },
              },
    });
    return moved._tag === "Success" ? null : formatEnvironmentQueryError(moved.cause);
  };
}

/**
 * Builds and runs the "Move to bot" menu item. `run` returns false for ids that aren't
 * moves, so callers can chain it with their own menu handlers.
 */
export function useMoveProjectToBotMenu() {
  const bots = useAtomValue(logicalBotsAtom);
  const botEnvironmentIds = new Set(useBotEnvironmentIds());
  const environmentLabels = new Map(
    useEnvironmentIdentities().map((environment) => [environment.environmentId, environment.label]),
  );
  const moveToBot = useMoveProjectToLogicalBot();
  const build = (members: ReadonlyArray<MoveProjectMember>) =>
    buildMoveToBotMenuItem(members, bots, botEnvironmentIds, environmentLabels);
  const run = (id: string, members: ReadonlyArray<MoveProjectMember>): boolean => {
    const move = parseMoveToBotMenuId(id);
    if (!move) return false;
    const project = members.find(
      (member) => member.environmentId === move.environmentId && member.id === move.projectId,
    );
    const bot =
      move.botKey === NO_BOT_KEY ? null : bots.find((candidate) => candidate.key === move.botKey);
    if (bot === undefined) return true;
    void moveToBot({ environmentId: move.environmentId, id: move.projectId }, bot).then((error) => {
      if (error === null) {
        toastManager.add({
          type: "success",
          title:
            bot === null
              ? `${project?.title ?? "The project"} has no bot now`
              : `Moved ${project?.title ?? "the project"} to ${bot.name}`,
        });
      } else {
        toastManager.add({
          type: "error",
          title: `Could not move ${project?.title ?? "the project"}`,
          description: error,
        });
      }
    });
    return true;
  };
  return { build, run };
}
