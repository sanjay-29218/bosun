import { projectBotId } from "@t3tools/client-runtime/state/bot-rail";
import { CAPTAIN_BOT_ID } from "@t3tools/contracts";

/** The given projects grouped by the bot that owns them, keeping their order. */
export function groupProjectsByBot<Project extends { readonly botId?: string | undefined }>(
  projects: ReadonlyArray<Project>,
): ReadonlyMap<string, ReadonlyArray<Project>> {
  const groups = new Map<string, Project[]>();
  for (const project of projects) {
    const botId = projectBotId(project);
    const group = groups.get(botId);
    if (group) group.push(project);
    else groups.set(botId, [project]);
  }
  return groups;
}

/** The full rail order with `botId` moved by `offset`, or null when it can't move that way. */
export function moveBotInOrder(
  botIds: ReadonlyArray<string>,
  botId: string,
  offset: -1 | 1,
): string[] | null {
  const from = botIds.indexOf(botId);
  const to = from + offset;
  if (from === -1 || to < 0 || to >= botIds.length) return null;
  const next = [...botIds];
  next.splice(from, 1);
  next.splice(to, 0, botId);
  return next;
}

/** Why a bot can't be deleted yet, matching the server's rule; null when it can. */
export function botDeleteBlocker(botId: string, ownedProjects: number): string | null {
  if (botId === CAPTAIN_BOT_ID) return "Captain can't be deleted.";
  if (ownedProjects > 0)
    return `Move its ${ownedProjects === 1 ? "project" : `${ownedProjects} projects`} to another bot first.`;
  return null;
}
