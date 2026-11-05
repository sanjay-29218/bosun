import {
  createLogicalBotResolver,
  logicalBotMemberOn,
  projectBotId,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import type { ContextMenuItem, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { botsEnvironment } from "../../state/bots";
import { logicalBotsAtom, useBotEnvironmentIds } from "../../state/botRail";
import { formatEnvironmentQueryError } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";

export interface MoveProjectMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly title: string;
  readonly botId?: string | undefined;
  /** Names the checkout when a project lives on several environments. */
  readonly environmentLabel: string | null;
}

const MOVE_PREFIX = "move-to-bot:";

/**
 * "Move to bot" for a project's context menu: every bot, on each checkout's environment that
 * runs bots, the current owner checked. A bot that environment doesn't have yet is created there
 * by the move. A project on several environments gets one submenu per checkout, since bots are
 * environment-local. Null when there is nowhere to move it.
 */
export function buildMoveToBotMenuItem(
  members: ReadonlyArray<MoveProjectMember>,
  bots: ReadonlyArray<LogicalBot>,
  botEnvironmentIds: ReadonlySet<EnvironmentId>,
): ContextMenuItem<string> | null {
  const ownerOf = createLogicalBotResolver(bots);
  const botItems = (member: MoveProjectMember): ContextMenuItem<string>[] => {
    if (!botEnvironmentIds.has(member.environmentId)) return [];
    const owner = ownerOf(member.environmentId, projectBotId(member));
    return bots.map((bot) => ({
      id: `${MOVE_PREFIX}${JSON.stringify([member.environmentId, member.id, bot.key])}`,
      label: bot.name,
      ...(bot.key === owner ? { checked: true, disabled: true } : {}),
    }));
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
  if (!id.startsWith(MOVE_PREFIX) || id.startsWith(`${MOVE_PREFIX}menu`)) return null;
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
 * Moves a project to a rail entry's bot on the project's own environment. Bots are
 * environment-local, so when the rail knows none there the server finds the bot with the entry's
 * logical key, or creates it once with the entry's name, look and model. Returns an error
 * description, or null once moved.
 */
export function useMoveProjectToLogicalBot() {
  const moveProject = useAtomCommand(botsEnvironment.moveProject, { reportFailure: false });
  return async (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    bot: LogicalBot,
  ): Promise<string | null> => {
    const member = logicalBotMemberOn(bot, project.environmentId);
    // Every entry has a bot somewhere; the first one is the copy's source.
    const source = bot.members[0]!;
    const definition =
      member !== null
        ? undefined
        : Option.getOrNull(
            AsyncResult.value(
              appAtomRegistry.get(
                botsEnvironment.list({ environmentId: source.environmentId, input: {} }),
              ),
            ),
          )?.find((candidate) => candidate.id === source.botId);
    const moved = await moveProject({
      environmentId: project.environmentId,
      input:
        member !== null
          ? { projectId: project.id, botId: member }
          : {
              projectId: project.id,
              botId: source.botId,
              ensureBot: {
                name: bot.name,
                avatar: bot.avatar,
                color: bot.color,
                ...(definition?.modelSelection
                  ? { modelSelection: definition.modelSelection }
                  : {}),
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
  const moveToBot = useMoveProjectToLogicalBot();
  const build = (members: ReadonlyArray<MoveProjectMember>) =>
    buildMoveToBotMenuItem(members, bots, botEnvironmentIds);
  const run = (id: string, members: ReadonlyArray<MoveProjectMember>): boolean => {
    const move = parseMoveToBotMenuId(id);
    if (!move) return false;
    const project = members.find(
      (member) => member.environmentId === move.environmentId && member.id === move.projectId,
    );
    const bot = bots.find((candidate) => candidate.key === move.botKey);
    if (!bot) return true;
    void moveToBot({ environmentId: move.environmentId, id: move.projectId }, bot).then((error) => {
      if (error === null) {
        toastManager.add({
          type: "success",
          title: `Moved ${project?.title ?? "the project"} to ${bot.name}`,
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
