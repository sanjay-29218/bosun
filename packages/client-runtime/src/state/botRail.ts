import { CAPTAIN_BOT_ID, type Bot, type EnvironmentId } from "@t3tools/contracts";

import { botNeedsYouKey } from "./crewBoard.ts";

/** A project's owner. Projects from older servers have no `botId` and belong to Captain. */
export function projectBotId(project: { readonly botId?: string | undefined }): string {
  return project.botId ?? CAPTAIN_BOT_ID;
}

export interface EnvironmentBots {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<Pick<Bot, "id" | "name" | "emoji" | "position">>;
}

export interface LogicalBotMember {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
}

/**
 * One rail entry: the same bot on every connected environment. Bots are environment-local, so
 * the rail merges them like logical projects: Captain by id, the rest by name.
 */
export interface LogicalBot {
  readonly key: string;
  readonly name: string;
  readonly emoji: string;
  readonly members: ReadonlyArray<LogicalBotMember>;
}

const CAPTAIN_KEY = `id:${CAPTAIN_BOT_ID}`;

export function logicalBotKey(bot: { readonly id: string; readonly name: string }): string {
  return bot.id === CAPTAIN_BOT_ID ? CAPTAIN_KEY : `name:${bot.name.trim().toLocaleLowerCase()}`;
}

/**
 * Rail entries across environments, given in priority order (primary first). The first
 * environment that has a bot decides its name, avatar and place in the rail.
 */
export function buildLogicalBots(environments: ReadonlyArray<EnvironmentBots>): LogicalBot[] {
  const byKey = new Map<string, { name: string; emoji: string; members: LogicalBotMember[] }>();
  for (const { environmentId, bots } of environments) {
    for (const bot of [...bots].sort((left, right) => left.position - right.position)) {
      const key = logicalBotKey(bot);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.members.some((member) => member.environmentId === environmentId)) {
          existing.members.push({ environmentId, botId: bot.id });
        }
        continue;
      }
      byKey.set(key, {
        name: bot.name,
        emoji: bot.emoji,
        members: [{ environmentId, botId: bot.id }],
      });
    }
  }
  return [...byKey].map(([key, bot]) => ({ key, ...bot }));
}

/**
 * The selected rail entry. Each environment remembers its own active bot; the first
 * environment (primary first) whose remembered bot is still listed wins. Falls back to the
 * first entry, so a deleted bot or a new environment never leaves the rail without a selection.
 */
export function resolveActiveLogicalBot(
  bots: ReadonlyArray<LogicalBot>,
  activeBotIdByEnvironmentId: Readonly<Record<string, string>>,
  environmentOrder: ReadonlyArray<EnvironmentId>,
): LogicalBot | null {
  for (const environmentId of environmentOrder) {
    const botId = activeBotIdByEnvironmentId[environmentId];
    if (botId === undefined) continue;
    const match = bots.find((bot) =>
      bot.members.some(
        (member) => member.environmentId === environmentId && member.botId === botId,
      ),
    );
    if (match) return match;
  }
  return bots[0] ?? null;
}

/** What selecting `bot` remembers: its bot on each of its environments, others untouched. */
export function selectLogicalBot(
  activeBotIdByEnvironmentId: Readonly<Record<string, string>>,
  bot: LogicalBot,
): Record<string, string> {
  const next = { ...activeBotIdByEnvironmentId };
  for (const member of bot.members) next[member.environmentId] = member.botId;
  return next;
}

/**
 * Maps an environment's bot to its rail entry. A bot the rail doesn't know yet (its
 * environment's list is still loading, or the server predates bots) falls under Captain, so a
 * project is never hidden from every entry.
 */
export function createLogicalBotResolver(bots: ReadonlyArray<LogicalBot>) {
  const byMember = new Map<string, string>();
  for (const bot of bots) {
    for (const member of bot.members) {
      byMember.set(botNeedsYouKey(member.environmentId, member.botId), bot.key);
    }
  }
  return (environmentId: EnvironmentId, botId: string): string =>
    byMember.get(botNeedsYouKey(environmentId, botId)) ?? CAPTAIN_KEY;
}

/** `${environmentId}:${projectId}` keys of the projects `bot` owns. */
export function logicalBotProjectKeys(
  bot: LogicalBot,
  bots: ReadonlyArray<LogicalBot>,
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly botId?: string | undefined;
  }>,
): Set<string> {
  const resolve = createLogicalBotResolver(bots);
  const keys = new Set<string>();
  for (const project of projects) {
    if (resolve(project.environmentId, projectBotId(project)) === bot.key) {
      keys.add(`${project.environmentId}:${project.id}`);
    }
  }
  return keys;
}

/** Sums `countNeedsYouByBot` counts (keyed by `botNeedsYouKey`) per rail entry. */
export function countNeedsYouByLogicalBot(
  bots: ReadonlyArray<LogicalBot>,
  countsByBot: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const owners = new Map<string, string>();
  for (const bot of bots) {
    for (const member of bot.members) {
      owners.set(botNeedsYouKey(member.environmentId, member.botId), bot.key);
    }
  }
  const counts = new Map<string, number>();
  for (const [memberKey, count] of countsByBot) {
    const key = owners.get(memberKey) ?? CAPTAIN_KEY;
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return counts;
}

/**
 * The environments the rail and sidebar show. `selected` is the persisted filter (null for
 * all). Selected environments that aren't connected are ignored; when none of them is, the
 * filter reads as all so the sidebar never goes empty because a machine went offline.
 */
export function resolveEnvironmentFilter(
  selected: ReadonlyArray<string> | null,
  available: ReadonlyArray<EnvironmentId>,
): ReadonlySet<EnvironmentId> | null {
  if (selected === null) return null;
  const wanted = new Set(selected);
  const visible = available.filter((environmentId) => wanted.has(environmentId));
  return visible.length === 0 || visible.length === available.length ? null : new Set(visible);
}
