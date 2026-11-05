import {
  createLogicalBotResolver,
  logicalBotMemberOn,
  projectBotId,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import {
  CAPTAIN_BOT_ID,
  logicalBotKey,
  type ContextMenuItem,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, AtomRegistry } from "effect/reactivity";

import { randomUUID } from "../../lib/utils";
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
 * Which bot on `environmentId` a move to `bot` goes to: the one there with its logical key, or a
 * new one to create. `botsThere` is that environment's current list (null when it couldn't be
 * read). A new bot gets a fresh id: the source's id may belong to another bot there, such as a
 * namesake renamed only there. Captain is never created; every environment has it.
 */
export function botMoveTarget(
  bot: LogicalBot,
  environmentId: EnvironmentId,
  botsThere: ReadonlyArray<{ readonly id: string; readonly name: string }> | null,
  newBotId: () => string,
): { readonly botId: string } | { readonly create: string } {
  const there =
    botsThere?.find((candidate) => logicalBotKey(candidate) === bot.key)?.id ??
    (botsThere === null ? logicalBotMemberOn(bot, environmentId) : null);
  if (there !== null && there !== undefined) return { botId: there };
  if (bot.key === logicalBotKey({ id: CAPTAIN_BOT_ID, name: "" })) return { botId: CAPTAIN_BOT_ID };
  return { create: newBotId() };
}

/**
 * Moves a project to a rail entry's bot on the project's own environment. Bots are
 * environment-local, so one that environment doesn't have yet is created there first, with the
 * entry's name, look and model. Returns an error description, or null once moved.
 */
export function useMoveProjectToLogicalBot() {
  const moveProject = useAtomCommand(botsEnvironment.moveProject, { reportFailure: false });
  const createBot = useAtomCommand(botsEnvironment.create, { reportFailure: false });
  return async (
    project: { readonly environmentId: EnvironmentId; readonly id: ProjectId },
    bot: LogicalBot,
  ): Promise<string | null> => {
    let target = botMoveTarget(
      bot,
      project.environmentId,
      await currentBots(project.environmentId),
      () => `bot-${randomUUID()}`,
    );
    if ("create" in target) {
      // Every entry has a bot somewhere; the first one is the copy's source.
      const source = bot.members[0]!;
      const definition = Option.getOrNull(
        AsyncResult.value(
          appAtomRegistry.get(
            botsEnvironment.list({ environmentId: source.environmentId, input: {} }),
          ),
        ),
      )?.find((candidate) => candidate.id === source.botId);
      const created = await createBot({
        environmentId: project.environmentId,
        input: {
          id: target.create,
          name: bot.name,
          avatar: bot.avatar,
          color: bot.color,
          ...(definition?.modelSelection ? { modelSelection: definition.modelSelection } : {}),
        },
      });
      if (created._tag === "Success") target = { botId: created.value.id };
      else {
        // Someone may have made it there meanwhile; that one is the bot to move to.
        const again = botMoveTarget(
          bot,
          project.environmentId,
          await currentBots(project.environmentId),
          () => "",
        );
        if ("create" in again) return formatEnvironmentQueryError(created.cause);
        target = again;
      }
    }
    const moved = await moveProject({
      environmentId: project.environmentId,
      input: { projectId: project.id, botId: target.botId },
    });
    return moved._tag === "Success" ? null : formatEnvironmentQueryError(moved.cause);
  };
}

/** An environment's bots as its server lists them now, or null when they can't be read. */
const currentBots = (environmentId: EnvironmentId) => {
  const list = botsEnvironment.list({ environmentId, input: {} });
  appAtomRegistry.refresh(list);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, list, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
};

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
