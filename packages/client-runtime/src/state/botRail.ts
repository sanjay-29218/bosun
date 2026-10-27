import {
  botHeadquartersThreadId,
  CAPTAIN_BOT_ID,
  headquartersBotId,
  type Bot,
  type BotAvatar,
  type EnvironmentId,
  type ProjectIconColor,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { botNeedsYouKey, createThreadBotKeyResolver, type BotOwnedProject } from "./crewBoard.ts";
import { hasUnseenCompletion, hasUnseenFailure, isThreadWorking } from "./threadInbox.ts";

/** A project's owner. Projects from older servers have no `botId` and belong to Captain. */
export function projectBotId(project: { readonly botId?: string | undefined }): string {
  return project.botId ?? CAPTAIN_BOT_ID;
}

export interface EnvironmentBots {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<Pick<Bot, "id" | "name" | "avatar" | "color" | "position">>;
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
  readonly avatar: BotAvatar;
  readonly color: ProjectIconColor;
  readonly members: ReadonlyArray<LogicalBotMember>;
}

const CAPTAIN_KEY = `id:${CAPTAIN_BOT_ID}`;

export function logicalBotKey(bot: { readonly id: string; readonly name: string }): string {
  return bot.id === CAPTAIN_BOT_ID ? CAPTAIN_KEY : `name:${bot.name.trim().toLocaleLowerCase()}`;
}

/**
 * Rail entries across environments, given in priority order (primary first). The first
 * environment that has a bot decides its name, avatar, color and place in the rail. Two bots with
 * the same name on one environment stay separate entries; only the first one merges.
 */
export function buildLogicalBots(environments: ReadonlyArray<EnvironmentBots>): LogicalBot[] {
  const byKey = new Map<string, Omit<LogicalBot, "key"> & { members: LogicalBotMember[] }>();
  for (const { environmentId, bots } of environments) {
    for (const bot of [...bots].sort((left, right) => left.position - right.position)) {
      let key = logicalBotKey(bot);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.members.some((member) => member.environmentId === environmentId)) {
          existing.members.push({ environmentId, botId: bot.id });
          continue;
        }
        key = `id:${environmentId}:${bot.id}`;
      }
      byKey.set(key, {
        name: bot.name,
        avatar: bot.avatar,
        color: bot.color,
        members: [{ environmentId, botId: bot.id }],
      });
    }
  }
  return [...byKey].map(([key, bot]) => ({ key, ...bot }));
}

/**
 * The selected rail entry, or null for All bots. Each environment remembers its own active bot;
 * the first environment (primary first) whose remembered bot is still listed wins. Nothing
 * remembered, or a deleted bot, reads as All bots. A lone bot is always selected: All bots
 * only exists beside two or more.
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
  return bots.length === 1 ? bots[0]! : null;
}

/**
 * What selecting `bot` remembers: its bot on each of its environments, or nothing for All bots.
 * Other environments forget theirs, since an older choice there would otherwise outrank this
 * one in `resolveActiveLogicalBot` when `bot` lives only on a later environment.
 */
export function selectLogicalBot(
  _activeBotIdByEnvironmentId: Readonly<Record<string, string>>,
  bot: LogicalBot | null,
): Record<string, string> {
  if (bot === null) return {};
  return Object.fromEntries(bot.members.map((member) => [member.environmentId, member.botId]));
}

/**
 * Maps an environment's bot to its rail entry. A bot the rail doesn't know yet (its
 * environment's list is still loading, or the server predates bots) falls under Captain, so a
 * project is never hidden from every entry.
 */
function createLogicalBotResolver(bots: ReadonlyArray<LogicalBot>) {
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

/**
 * `${environmentId}:${threadId}` keys of `bot`'s headquarters threads, one per environment,
 * leaving out environments the filter hides.
 */
export function logicalBotHeadquartersKeys(
  bot: LogicalBot,
  environmentFilter: ReadonlySet<string> | null = null,
): Set<string> {
  return new Set(
    bot.members
      .filter((member) => environmentFilter === null || environmentFilter.has(member.environmentId))
      .map((member) => `${member.environmentId}:${botHeadquartersThreadId(member.botId)}`),
  );
}

/**
 * Whether the rail shows `thread`. Headquarters live in the Scratch project, so with a bot
 * picked (`headquarters` set) they show under their own bot, not by project.
 */
export function botRailShowsThread(
  thread: { readonly environmentId: string; readonly id: string; readonly projectId: string },
  projectKeys: ReadonlySet<string> | null,
  headquarters: ReadonlySet<string> | null,
): boolean {
  if (headquarters !== null && headquartersBotId(thread.id) !== null) {
    return headquarters.has(`${thread.environmentId}:${thread.id}`);
  }
  return projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`);
}

/** Rail entry keys by `botNeedsYouKey`; a key no entry lists falls under Captain. */
function logicalBotKeysByMember(bots: ReadonlyArray<LogicalBot>) {
  const owners = new Map<string, string>();
  for (const bot of bots) {
    for (const member of bot.members) {
      owners.set(botNeedsYouKey(member.environmentId, member.botId), bot.key);
    }
  }
  return (memberKey: string) => owners.get(memberKey) ?? CAPTAIN_KEY;
}

/** Sums `countNeedsYouByBot` counts (keyed by `botNeedsYouKey`) per rail entry. */
export function countNeedsYouByLogicalBot(
  bots: ReadonlyArray<LogicalBot>,
  countsByBot: ReadonlyMap<string, number>,
): ReadonlyMap<string, number> {
  const owner = logicalBotKeysByMember(bots);
  const counts = new Map<string, number>();
  for (const [memberKey, count] of countsByBot) {
    const key = owner(memberKey);
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  return counts;
}

/** What a bot's threads are doing besides waiting on you. */
export interface BotActivity {
  /** A run failed and nobody has opened the thread since. */
  readonly failed: boolean;
  readonly working: boolean;
  /** A run finished and nobody has opened the thread since. */
  readonly unread: boolean;
}

type BotActivityShell = Parameters<typeof isThreadWorking>[0] &
  Pick<EnvironmentThreadShell, "environmentId" | "id" | "projectId" | "archivedAt"> & {
    readonly lastVisitedAt?: string | null | undefined;
  };

const mergeActivity = (left: BotActivity | undefined, right: BotActivity): BotActivity =>
  left === undefined
    ? right
    : {
        failed: left.failed || right.failed,
        working: left.working || right.working,
        unread: left.unread || right.unread,
      };

/**
 * Activity per environment's bot, keyed by `botNeedsYouKey`. Bots with nothing going on are
 * left out. A server without visit tracking (`lastVisitedAt` undefined) never reads as unseen.
 */
export function botActivityByBot(
  shells: ReadonlyArray<BotActivityShell>,
  projects: ReadonlyArray<BotOwnedProject>,
): ReadonlyMap<string, BotActivity> {
  const ownerKey = createThreadBotKeyResolver(projects);
  const activity = new Map<string, BotActivity>();
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const visits = shell.lastVisitedAt !== undefined;
    const next: BotActivity = {
      failed: visits && hasUnseenFailure(shell),
      working: isThreadWorking(shell),
      unread: visits && hasUnseenCompletion(shell),
    };
    if (!next.failed && !next.working && !next.unread) continue;
    const key = ownerKey(shell);
    if (key === undefined) continue;
    activity.set(key, mergeActivity(activity.get(key), next));
  }
  return activity;
}

/** `botActivityByBot` merged per rail entry. */
export function botActivityByLogicalBot(
  bots: ReadonlyArray<LogicalBot>,
  activityByBot: ReadonlyMap<string, BotActivity>,
): ReadonlyMap<string, BotActivity> {
  const owner = logicalBotKeysByMember(bots);
  const merged = new Map<string, BotActivity>();
  for (const [memberKey, activity] of activityByBot) {
    const key = owner(memberKey);
    merged.set(key, mergeActivity(merged.get(key), activity));
  }
  return merged;
}

/** Every entry's activity at once, for All bots. */
export function combineBotActivity(activities: Iterable<BotActivity>): BotActivity | undefined {
  let combined: BotActivity | undefined;
  for (const activity of activities) combined = mergeActivity(combined, activity);
  return combined;
}

export type BotRailSignal =
  | { readonly kind: "needs-you"; readonly count: number }
  | { readonly kind: "failed" }
  | { readonly kind: "working" }
  | { readonly kind: "unread" };

/**
 * The one thing a rail icon shows, most urgent first: threads waiting on you, a failed run,
 * work in progress, then a finished run nobody has read.
 */
export function botRailSignal(
  needsYou: number,
  activity: BotActivity | undefined,
): BotRailSignal | null {
  if (needsYou > 0) return { kind: "needs-you", count: needsYou };
  if (activity?.failed) return { kind: "failed" };
  if (activity?.working) return { kind: "working" };
  if (activity?.unread) return { kind: "unread" };
  return null;
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
