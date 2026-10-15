import { projectBotId, type LogicalBot } from "@t3tools/client-runtime/state/bot-rail";
import type { ContextMenuItem, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useCallback } from "react";

import { botsEnvironment } from "../../state/bots";
import { logicalBotsAtom } from "../../state/botRail";
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
 * "Move to bot" for a project's context menu: the bots on each checkout's environment,
 * the current owner checked. A project on several environments gets one submenu per
 * checkout, since bots are environment-local. Null when there is nowhere to move it.
 */
export function buildMoveToBotMenuItem(
  members: ReadonlyArray<MoveProjectMember>,
  bots: ReadonlyArray<LogicalBot>,
): ContextMenuItem<string> | null {
  const botItems = (member: MoveProjectMember): ContextMenuItem<string>[] => {
    const owner = projectBotId(member);
    return bots.flatMap((bot) => {
      const target = bot.members.find(
        (candidate) => candidate.environmentId === member.environmentId,
      );
      if (!target) return [];
      return [
        {
          id: `${MOVE_PREFIX}${JSON.stringify([member.environmentId, member.id, target.botId])}`,
          label: bot.name,
          ...(target.botId === owner ? { checked: true, disabled: true } : {}),
        },
      ];
    });
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
): { environmentId: EnvironmentId; projectId: ProjectId; botId: string } | null {
  if (!id.startsWith(MOVE_PREFIX) || id.startsWith(`${MOVE_PREFIX}menu`)) return null;
  try {
    const [environmentId, projectId, botId] = JSON.parse(id.slice(MOVE_PREFIX.length)) as [
      EnvironmentId,
      ProjectId,
      string,
    ];
    return { environmentId, projectId, botId };
  } catch {
    return null;
  }
}

/**
 * Builds and runs the "Move to bot" menu item. `run` returns false for ids that aren't
 * moves, so callers can chain it with their own menu handlers.
 */
export function useMoveProjectToBotMenu() {
  const bots = useAtomValue(logicalBotsAtom);
  const moveProject = useAtomCommand(botsEnvironment.moveProject, { reportFailure: false });
  const build = useCallback(
    (members: ReadonlyArray<MoveProjectMember>) => buildMoveToBotMenuItem(members, bots),
    [bots],
  );
  const run = useCallback(
    (id: string, members: ReadonlyArray<MoveProjectMember>): boolean => {
      const move = parseMoveToBotMenuId(id);
      if (!move) return false;
      const project = members.find(
        (member) => member.environmentId === move.environmentId && member.id === move.projectId,
      );
      const bot = bots.find((candidate) =>
        candidate.members.some(
          (member) => member.environmentId === move.environmentId && member.botId === move.botId,
        ),
      );
      void moveProject({
        environmentId: move.environmentId,
        input: { projectId: move.projectId, botId: move.botId },
      }).then((result) => {
        if (result._tag === "Success") {
          toastManager.add({
            type: "success",
            title: `Moved ${project?.title ?? "the project"} to ${bot?.name ?? "another bot"}`,
          });
        } else {
          toastManager.add({
            type: "error",
            title: `Could not move ${project?.title ?? "the project"}`,
            description: formatEnvironmentQueryError(result.cause),
          });
        }
      });
      return true;
    },
    [bots, moveProject],
  );
  return { build, run };
}
