import {
  botHeadquartersThreadId,
  headquartersBotId,
  headquartersProjectId,
  logicalBotKey,
  type Bot,
  type BotAvatar,
  type EnvironmentId,
  type ProjectIconColor,
  type ProjectId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { botNeedsYouKey, createThreadBotKeyResolver, type BotOwnedProject } from "./crewBoard.ts";
import { hasUnseenCompletion, hasUnseenFailure, isThreadWorking } from "./threadInbox.ts";

/** A project's owner, or null when it has none. */
export function projectBotId(project: {
  readonly botId?: string | null | undefined;
}): string | null {
  return project.botId ?? null;
}

export interface EnvironmentBots {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<
    Pick<Bot, "id" | "name" | "avatar" | "color" | "position" | "pinned">
  >;
}

export interface LogicalBotMember {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  /** This environment's own pin; absent reads as pinned. */
  readonly pinned?: boolean;
}

/**
 * One rail entry: the same bot on every connected environment. Bots are environment-local, so
 * the rail merges them like logical projects, by name.
 */
export interface LogicalBot {
  readonly key: string;
  readonly name: string;
  readonly avatar: BotAvatar;
  readonly color: ProjectIconColor;
  readonly members: ReadonlyArray<LogicalBotMember>;
  /** Shown in the main rail: pinned on any of its environments. */
  readonly pinned: boolean;
}

/**
 * Rail entries across environments, given in priority order (primary first). The first
 * environment that has a bot decides its name, avatar, color and place in the rail. Two bots with
 * the same name on one environment stay separate entries; only the first one merges.
 */
export function buildLogicalBots(environments: ReadonlyArray<EnvironmentBots>): LogicalBot[] {
  const byKey = new Map<
    string,
    Omit<LogicalBot, "key"> & { members: LogicalBotMember[]; pinned: boolean }
  >();
  for (const { environmentId, bots } of environments) {
    for (const bot of [...bots].sort((left, right) => left.position - right.position)) {
      let key = logicalBotKey(bot);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.members.some((member) => member.environmentId === environmentId)) {
          existing.members.push({ environmentId, botId: bot.id, pinned: bot.pinned ?? true });
          existing.pinned ||= bot.pinned ?? true;
          continue;
        }
        key = `id:${environmentId}:${bot.id}`;
      }
      byKey.set(key, {
        name: bot.name,
        avatar: bot.avatar,
        color: bot.color,
        members: [{ environmentId, botId: bot.id, pinned: bot.pinned ?? true }],
        pinned: bot.pinned ?? true,
      });
    }
  }
  return [...byKey].map(([key, bot]) => ({ key, ...bot }));
}

/**
 * Changes whenever anything a client shows or writes from the rail entries does, each
 * environment's own pin included: a rollback after a failed pin restores those.
 */
export const logicalBotsSignature = (bots: ReadonlyArray<LogicalBot>) =>
  bots
    .map(
      (bot) =>
        `${bot.key}|${bot.name}|${JSON.stringify(bot.avatar)}|${bot.color}|${bot.pinned}|${bot.members
          .map((member) => `${member.environmentId}/${member.botId}/${member.pinned ?? true}`)
          .join(",")}`,
    )
    .join("\n");

/**
 * The selected rail entry, null only while no bot is listed. Each environment remembers its own
 * active bot; the first environment (primary first) whose remembered bot is still listed wins.
 * Nothing remembered, or a deleted bot, selects the first bot.
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

/**
 * What selecting `bot` remembers: its bot on each of its environments. Other environments forget
 * theirs, since an older choice there would otherwise outrank this one in
 * `resolveActiveLogicalBot` when `bot` lives only on a later environment.
 */
export function selectLogicalBot(bot: LogicalBot): Record<string, string> {
  return Object.fromEntries(bot.members.map((member) => [member.environmentId, member.botId]));
}

/**
 * Maps an environment's bot to its rail entry, or null for no bot. A bot the rail doesn't know
 * yet (its environment's list is still loading) maps to null too, like a project with no bot.
 */
export function createLogicalBotResolver(bots: ReadonlyArray<LogicalBot>) {
  const byMember = new Map<string, string>();
  for (const bot of bots) {
    for (const member of bot.members) {
      byMember.set(botNeedsYouKey(member.environmentId, member.botId), bot.key);
    }
  }
  return (environmentId: EnvironmentId, botId: string | null): string | null =>
    botId === null ? null : (byMember.get(botNeedsYouKey(environmentId, botId)) ?? null);
}

/**
 * `${environmentId}:${projectId}` keys of the projects `bot` shows: the ones it owns, and the
 * ones with no bot, which every bot shows so they are never hidden.
 */
export function logicalBotProjectKeys(
  bot: LogicalBot,
  bots: ReadonlyArray<LogicalBot>,
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly botId?: string | null | undefined;
  }>,
): Set<string> {
  const resolve = createLogicalBotResolver(bots);
  const keys = new Set<string>();
  for (const project of projects) {
    const owner = resolve(project.environmentId, projectBotId(project));
    if (owner === null || owner === bot.key) keys.add(`${project.environmentId}:${project.id}`);
  }
  return keys;
}

/**
 * Keys the thread list shows for the rail's pick, or null when nothing narrows it. Owners are
 * read from every bot, pinned or not; projects the list is scoped to always show, such as a
 * picked manager's whose bot isn't pinned.
 */
export function railProjectKeys(input: {
  readonly active: LogicalBot | null;
  readonly pinnedBots: ReadonlyArray<LogicalBot>;
  readonly allBots: ReadonlyArray<LogicalBot>;
  readonly projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly botId?: string | null | undefined;
  }>;
  readonly environmentFilter: ReadonlySet<EnvironmentId> | null;
  /** The projects the thread list is scoped to, if any. */
  readonly scopedProjects?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
  }>;
}): Set<string> | null {
  const { active, environmentFilter } = input;
  const filterByBot = active !== null && input.pinnedBots.length > 1;
  if (!filterByBot && environmentFilter === null) return null;
  const inEnvironment =
    environmentFilter === null
      ? input.projects
      : input.projects.filter((project) => environmentFilter.has(project.environmentId));
  if (!filterByBot) {
    return new Set(inEnvironment.map((project) => `${project.environmentId}:${project.id}`));
  }
  const keys = logicalBotProjectKeys(active, input.allBots, inEnvironment);
  for (const project of input.scopedProjects ?? []) {
    if (environmentFilter === null || environmentFilter.has(project.environmentId)) {
      keys.add(`${project.environmentId}:${project.id}`);
    }
  }
  return keys;
}

/**
 * A rail entry's projects on every connected environment: the ones it owns, the ones it can
 * take, and the ones on environments without bots (`botEnvironmentIds` leaves them out), which
 * no bot can take until that environment runs Bosun. Moving a project goes to the entry's bot on
 * the project's own environment, which `logicalBotMemberOn` finds or a move creates.
 */
export function logicalBotProjectLists<
  Project extends {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly botId?: string | null | undefined;
  },
>(
  bot: LogicalBot,
  bots: ReadonlyArray<LogicalBot>,
  projects: ReadonlyArray<Project>,
  botEnvironmentIds: ReadonlySet<EnvironmentId>,
): {
  readonly owned: ReadonlyArray<Project>;
  readonly available: ReadonlyArray<Project>;
  readonly withoutBots: ReadonlyArray<Project>;
} {
  const resolve = createLogicalBotResolver(bots);
  const owned: Project[] = [];
  const available: Project[] = [];
  const withoutBots: Project[] = [];
  for (const project of projects) {
    if (!botEnvironmentIds.has(project.environmentId)) withoutBots.push(project);
    else if (resolve(project.environmentId, projectBotId(project)) === bot.key) owned.push(project);
    else available.push(project);
  }
  return { owned, available, withoutBots };
}

/** The entry's bot on `environmentId`, or null when moving a project there creates it first. */
export function logicalBotMemberOn(bot: LogicalBot, environmentId: EnvironmentId): string | null {
  return bot.members.find((member) => member.environmentId === environmentId)?.botId ?? null;
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

/** Rail entry keys by `botNeedsYouKey`; undefined for a key no entry lists. */
function logicalBotKeysByMember(bots: ReadonlyArray<LogicalBot>) {
  const owners = new Map<string, string>();
  for (const bot of bots) {
    for (const member of bot.members) {
      owners.set(botNeedsYouKey(member.environmentId, member.botId), bot.key);
    }
  }
  return (memberKey: string) => owners.get(memberKey);
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
    if (key === undefined) continue;
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
    if (key === undefined) continue;
    merged.set(key, mergeActivity(merged.get(key), activity));
  }
  return merged;
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

/** Whether a project's manager shows in the main rail. Older servers send no flag: pinned. */
export function isManagerPinned(project: {
  readonly managerPinned?: boolean | undefined;
}): boolean {
  return project.managerPinned ?? true;
}

/**
 * Threads waiting on you that the main rail hides: a project manager's thread when that manager
 * isn't pinned, and any other thread whose bot isn't pinned. The Bots place shows this count, so
 * nothing unpinned goes silent.
 */
export function countHiddenNeedsYou(input: {
  readonly bots: ReadonlyArray<LogicalBot>;
  readonly shells: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly projectId: ProjectId;
  }>;
  readonly projects: ReadonlyArray<
    BotOwnedProject & { readonly managerPinned?: boolean | undefined }
  >;
}): number {
  const unpinnedManagers = new Set(
    input.projects
      .filter((project) => !isManagerPinned(project))
      .map((project) => `${project.environmentId}:${project.id}`),
  );
  const unpinnedBots = new Set<string>();
  for (const bot of input.bots) {
    if (bot.pinned) continue;
    for (const member of bot.members) {
      unpinnedBots.add(botNeedsYouKey(member.environmentId, member.botId));
    }
  }
  const ownerKey = createThreadBotKeyResolver(input.projects);
  let count = 0;
  for (const shell of input.shells) {
    // A manager's thread shows with the manager, whatever its bot's pin.
    const managerOf = headquartersProjectId(shell.id);
    if (managerOf !== null) {
      if (unpinnedManagers.has(`${shell.environmentId}:${managerOf}`)) count += 1;
      continue;
    }
    const owner = ownerKey(shell);
    if (owner !== undefined && unpinnedBots.has(owner)) count += 1;
  }
  return count;
}

/**
 * Pinned project managers the rail lists, by title: one per project whose manager is pinned,
 * whether or not its thread exists yet (opening it makes one). Scratch, bots' homes, servers
 * without features and managers turned off (their thread archived) are left out.
 */
export function pinnedProjectManagers<
  Project extends {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly managerPinned?: boolean | undefined;
    readonly isScratch?: true;
    readonly isBotHome?: true;
  },
>(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly managerEnvironmentIds: ReadonlySet<EnvironmentId>;
  /** `${environmentId}:${projectId}` of managers whose thread is archived. */
  readonly archivedManagers: ReadonlySet<string>;
}): Project[] {
  return input.projects
    .filter(
      (project) =>
        !project.isScratch &&
        !project.isBotHome &&
        isManagerPinned(project) &&
        input.managerEnvironmentIds.has(project.environmentId) &&
        !input.archivedManagers.has(`${project.environmentId}:${project.id}`),
    )
    .sort((left, right) => left.title.localeCompare(right.title));
}

/**
 * Writes one pin to every target. If any write fails, the targets already written go back to
 * their previous value, so a bot isn't left pinned on some environments only. Returns the first
 * failure, or null.
 */
export async function writePins<Target extends { readonly previous: boolean }, Failure>(
  targets: ReadonlyArray<Target>,
  pinned: boolean,
  write: (target: Target, pinned: boolean) => Promise<Failure | null>,
): Promise<Failure | null> {
  const results = await Promise.all(targets.map((target) => write(target, pinned)));
  const failure = results.find((result) => result !== null) ?? null;
  if (failure === null) return null;
  await Promise.all(
    targets.flatMap((target, index) =>
      results[index] === null && target.previous !== pinned ? [write(target, target.previous)] : [],
    ),
  );
  return failure;
}
