import { CAPTAIN_BOT_ID } from "@t3tools/contracts";

/** A project's owner. Projects from older servers have no `botId` and belong to Captain. */
export function projectBotId(project: { readonly botId?: string | undefined }): string {
  return project.botId ?? CAPTAIN_BOT_ID;
}

/** How many of the given projects each bot owns. */
export function countProjectsByBot(
  projects: ReadonlyArray<{ readonly botId?: string | undefined }>,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const project of projects) {
    const botId = projectBotId(project);
    counts.set(botId, (counts.get(botId) ?? 0) + 1);
  }
  return counts;
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
