import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";

/** The given projects grouped by the bot that owns them (null: no bot), keeping their order. */
export function groupProjectsByBot<Project extends { readonly botId?: string | null | undefined }>(
  projects: ReadonlyArray<Project>,
): ReadonlyMap<string | null, ReadonlyArray<Project>> {
  const groups = new Map<string | null, Project[]>();
  for (const project of projects) {
    const botId = projectBotId(project);
    const group = groups.get(botId);
    if (group) group.push(project);
    else groups.set(botId, [project]);
  }
  return groups;
}

/** The full rail order with `botId` moved to `targetId`'s place, or null when nothing moves. */
export function moveBotTo(
  botIds: ReadonlyArray<string>,
  botId: string,
  targetId: string,
): string[] | null {
  const from = botIds.indexOf(botId);
  const to = botIds.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...botIds];
  next.splice(from, 1);
  next.splice(to, 0, botId);
  return next;
}

/** The full rail order with `botId` moved by `offset`, or null when it can't move that way. */
export function moveBotInOrder(
  botIds: ReadonlyArray<string>,
  botId: string,
  offset: -1 | 1,
): string[] | null {
  const target = botIds[botIds.indexOf(botId) + offset];
  return botIds.includes(botId) && target !== undefined ? moveBotTo(botIds, botId, target) : null;
}

/** Why a bot can't be deleted yet, matching the server's rule; null when it can. */
export function botDeleteBlocker(ownedProjects: number): string | null {
  if (ownedProjects > 0)
    return `Unlink its ${ownedProjects === 1 ? "project" : `${ownedProjects} projects`} first.`;
  return null;
}
