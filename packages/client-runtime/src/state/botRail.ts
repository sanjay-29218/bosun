import {
  botHeadquartersThreadId,
  headquartersBotId,
  headquartersProjectId,
  isStandingThread,
  type Bot,
  type BotAvatar,
  type EnvironmentId,
  type ProjectIconColor,
  type ProjectId,
  type ProjectRemoteBot,
  type ProjectRemoteManager,
  type ThreadId,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";
import { botNeedsYouKey, createThreadBotKeyResolver, type BotOwnedProject } from "./crewBoard.ts";
import { threadKey } from "./entities.ts";
import { hasUnseenCompletion, hasUnseenFailure, isThreadWorking } from "./threadInbox.ts";
import { isShownUnderParent } from "./threadShell.ts";
import { groupWorkThreads, nestChildFeatureGroups, type WorkGroupThread } from "./workGroups.ts";

/** A project's owner, or null when it has none. */
export function projectBotId(project: {
  readonly botId?: string | null | undefined;
}): string | null {
  return project.botId ?? null;
}

export interface OwnedProject {
  readonly environmentId: EnvironmentId;
  readonly botId?: string | null | undefined;
  readonly remoteBot?: ProjectRemoteBot | null | undefined;
}

/**
 * The bot that owns a project and the environment it lives on: one on the project's own
 * environment, or one elsewhere (`remoteBot`). Null when it has none.
 */
export function projectOwner(
  project: OwnedProject,
): { readonly environmentId: EnvironmentId; readonly botId: string } | null {
  if (project.remoteBot != null) {
    return { environmentId: project.remoteBot.environmentId, botId: project.remoteBot.botId };
  }
  return project.botId == null
    ? null
    : { environmentId: project.environmentId, botId: project.botId };
}

export interface EnvironmentBots {
  readonly environmentId: EnvironmentId;
  readonly bots: ReadonlyArray<
    Pick<Bot, "id" | "name" | "avatar" | "color" | "position" | "pinned"> &
      Partial<Pick<Bot, "linkedEnvironmentIds">>
  >;
}

export interface LogicalBotMember {
  readonly environmentId: EnvironmentId;
  readonly botId: string;
  /** This environment's own pin; absent reads as pinned. */
  readonly pinned?: boolean;
}

/**
 * One rail entry: one bot on the environment it lives on. Its single member keeps the shape
 * callers already read; same-named bots on other environments are separate entries.
 */
export interface LogicalBot {
  readonly key: string;
  readonly name: string;
  readonly avatar: BotAvatar;
  readonly color: ProjectIconColor;
  readonly members: ReadonlyArray<LogicalBotMember>;
  /** Shown in the main rail. */
  readonly pinned: boolean;
  /** The environments linked to its home; it works on each of them. */
  readonly linkedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

/**
 * Rail entries across environments, given in priority order (primary first), each environment's
 * bots in their rail order.
 */
export function buildLogicalBots(environments: ReadonlyArray<EnvironmentBots>): LogicalBot[] {
  return environments.flatMap(({ environmentId, bots }) =>
    [...bots]
      .sort((left, right) => left.position - right.position)
      .map((bot) => logicalBotOf(environmentId, bot)),
  );
}

/**
 * Rail entries from connected environments only. An offline environment's kept bots list is
 * for the Bots lists; here it would keep a bot of that machine active and hide others' projects.
 */
export function buildConnectedLogicalBots(
  environments: ReadonlyArray<EnvironmentBots>,
  connectedEnvironmentIds: ReadonlyArray<EnvironmentId>,
): LogicalBot[] {
  return buildLogicalBots(
    environments.filter(({ environmentId }) => connectedEnvironmentIds.includes(environmentId)),
  );
}

/** The rail entry for one environment's bot. */
export function logicalBotOf(
  environmentId: EnvironmentId,
  bot: EnvironmentBots["bots"][number],
): LogicalBot {
  return {
    key: `id:${environmentId}:${bot.id}`,
    name: bot.name,
    avatar: bot.avatar,
    color: bot.color,
    members: [{ environmentId, botId: bot.id, pinned: bot.pinned ?? true }],
    pinned: bot.pinned ?? true,
    linkedEnvironmentIds: bot.linkedEnvironmentIds ?? [],
  };
}

/** The environment a rail entry's bot lives on. */
export const logicalBotHome = (bot: LogicalBot): EnvironmentId => bot.members[0]!.environmentId;

/** Whether the bot may own and start work on projects on `environmentId`: its home or a linked one. */
export const logicalBotWorksOn = (bot: LogicalBot, environmentId: EnvironmentId): boolean =>
  logicalBotHome(bot) === environmentId || bot.linkedEnvironmentIds.includes(environmentId);

/**
 * The environments a bot list reads, primary first: bot environments that are connected, then
 * the rest of the known ones, whose last-known bots the device may have kept.
 */
export function botListEnvironmentIds(input: {
  readonly botEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly knownEnvironmentIds: ReadonlyArray<EnvironmentId>;
  readonly connectedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}): EnvironmentId[] {
  const connected = new Set(input.connectedEnvironmentIds);
  const online = input.botEnvironmentIds.filter((environmentId) => connected.has(environmentId));
  const offline = [...input.botEnvironmentIds, ...input.knownEnvironmentIds].filter(
    (environmentId) => !connected.has(environmentId),
  );
  return [...new Set([...online, ...offline])];
}

/**
 * A bot row's subtitle: its machine when several are known, then its projects, or Offline when
 * its machine can't be reached.
 */
export function botListSubtitle(input: {
  readonly machine: string | null;
  readonly online: boolean;
  readonly projects: string;
}): string {
  const detail = input.online ? input.projects : "Offline";
  return input.machine === null ? detail : `${input.machine} · ${detail}`;
}

/**
 * Changes whenever anything a client shows or writes from the rail entries does, each
 * environment's own pin included: a rollback after a failed pin restores those.
 */
export const logicalBotsSignature = (bots: ReadonlyArray<LogicalBot>) =>
  bots
    .map(
      (bot) =>
        `${bot.key}|${bot.name}|${JSON.stringify(bot.avatar)}|${bot.color}|${bot.pinned}|${bot.linkedEnvironmentIds.join(",")}|${bot.members
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
 * A machine, as far as the rail knows which bots it has. `connecting` is its first attempt still
 * underway; `unreachable` is offline, retrying after a failure, or disabled, so its cached
 * knowledge is all there is for now. `shown` bots are loaded and include one the rail shows: pinned,
 * on an environment the filter keeps whatever else connects.
 */
export interface RailBotSource {
  readonly connection: "connecting" | "connected" | "unreachable";
  readonly configured: boolean;
  readonly bots: "none" | "loading" | "loaded" | "shown";
}

/**
 * Whether the rail knows enough to choose the layout, and from then on: once a connected machine
 * shows a bot (any shown bot makes it cards), or no machine is still on its first attempt and every
 * connected one has sent its config and bot list. A machine connecting later doesn't unsettle it,
 * so the thread list doesn't fold into Projects and back while its bots load.
 */
export function railBotsSettled(settled: boolean, machines: ReadonlyArray<RailBotSource>): boolean {
  return (
    settled ||
    machines.some((machine) => machine.connection === "connected" && machine.bots === "shown") ||
    machines.every(
      (machine) =>
        machine.connection === "unreachable" ||
        (machine.connection === "connected" && machine.configured && machine.bots !== "loading"),
    )
  );
}

/**
 * The thread list's layout: Projects (the rail's, keeping empty folders), folders from the
 * setting, or cards. Pending until the bots are settled, since whether a bot exists decides it;
 * rows wait so a switch can't slide them under a click. Projects picked, with the rail showing,
 * needs no wait.
 */
export function resolveSidebarLayout(input: {
  readonly botsSettled: boolean;
  readonly projectsPicked: boolean;
  readonly showsRail: boolean;
  readonly hasActiveBot: boolean;
  readonly foldersSetting: boolean;
}): "pending" | "projects" | "folders" | "cards" {
  if (!input.botsSettled) return input.projectsPicked && input.showsRail ? "projects" : "pending";
  if (input.showsRail && !input.hasActiveBot) return "projects";
  return input.foldersSetting ? "folders" : "cards";
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
 * yet (its environment's list is still loading) maps to null too.
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

/** The rail entry that owns a project, here or from another environment; null for none. */
export function createProjectOwnerResolver(bots: ReadonlyArray<LogicalBot>) {
  const resolve = createLogicalBotResolver(bots);
  return (project: OwnedProject): string | null => {
    const owner = projectOwner(project);
    return owner === null ? null : resolve(owner.environmentId, owner.botId);
  };
}

/**
 * `${environmentId}:${projectId}` keys of the projects `bot` owns, here or on another
 * environment. A project with no owner, or one whose owner the rail doesn't list (not loaded
 * yet, or its machine is offline), shows under no bot; the Projects place lists it.
 */
export function logicalBotProjectKeys(
  bot: LogicalBot,
  bots: ReadonlyArray<LogicalBot>,
  projects: ReadonlyArray<OwnedProject & { readonly id: string }>,
): Set<string> {
  const resolve = createProjectOwnerResolver(bots);
  return new Set(
    projects
      .filter((project) => resolve(project) === bot.key)
      .map((project) => `${project.environmentId}:${project.id}`),
  );
}

/**
 * Keys the thread list shows for the rail's pick, or null when nothing narrows it. A picked bot
 * shows only what it owns, read from every bot, pinned or not; projects the list is scoped to
 * always show, such as a picked manager's whose bot isn't pinned.
 */
export function railProjectKeys(input: {
  readonly active: LogicalBot | null;
  readonly allBots: ReadonlyArray<LogicalBot>;
  readonly projects: ReadonlyArray<OwnedProject & { readonly id: string }>;
  readonly environmentFilter: ReadonlySet<EnvironmentId> | null;
  /** The projects the thread list is scoped to, if any. */
  readonly scopedProjects?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
  }>;
}): Set<string> | null {
  const { active, environmentFilter } = input;
  if (active === null && environmentFilter === null) return null;
  const inEnvironment =
    environmentFilter === null
      ? input.projects
      : input.projects.filter((project) => environmentFilter.has(project.environmentId));
  if (active === null) {
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
 * A rail entry's projects: the ones it owns, wherever they are, and the ones it can add, on its
 * home and the machines linked to it (`reachableEnvironmentIds`). Projects there on environments
 * without bots (`botEnvironmentIds` leaves them out) are listed apart: no bot can take them until
 * that environment runs Bosun.
 */
export function logicalBotProjectLists<Project extends OwnedProject & { readonly id: string }>(
  bot: LogicalBot,
  bots: ReadonlyArray<LogicalBot>,
  projects: ReadonlyArray<Project>,
  botEnvironmentIds: ReadonlySet<EnvironmentId>,
  reachableEnvironmentIds: ReadonlySet<EnvironmentId>,
): {
  readonly owned: ReadonlyArray<Project>;
  readonly available: ReadonlyArray<Project>;
  readonly withoutBots: ReadonlyArray<Project>;
} {
  const resolve = createProjectOwnerResolver(bots);
  const owned: Project[] = [];
  const available: Project[] = [];
  const withoutBots: Project[] = [];
  for (const project of projects) {
    if (resolve(project) === bot.key) owned.push(project);
    else if (!reachableEnvironmentIds.has(project.environmentId)) continue;
    else if (!botEnvironmentIds.has(project.environmentId)) withoutBots.push(project);
    else available.push(project);
  }
  return { owned, available, withoutBots };
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

type ListRowShell = WorkGroupThread &
  Pick<EnvironmentThreadShell, "environmentId" | "id" | "archivedAt" | "lineage"> & {
    readonly settledOverride?: string | null;
  };

const mergeActivity = (left: BotActivity | undefined, right: BotActivity): BotActivity =>
  left === undefined
    ? right
    : {
        failed: left.failed || right.failed,
        working: left.working || right.working,
        unread: left.unread || right.unread,
      };

const shellKey = (shell: { readonly environmentId: EnvironmentId; readonly id: ThreadId }) =>
  threadKey({ environmentId: shell.environmentId, threadId: shell.id });

/**
 * `threadKey`s of threads that are their own thread-list row, folded as the sidebar folds them
 * (nested and delegated threads, feature and request groups, child features), plus standing
 * threads, which the rail opens. Pass shells without hidden-tag threads.
 */
export function listRowThreadKeys(
  shells: ReadonlyArray<ListRowShell>,
  delegatedUnderParent: ReadonlySet<string>,
): ReadonlySet<string> {
  const live = shells.filter((shell) => shell.archivedAt === null);
  const listed = live.filter(
    (shell) =>
      !isStandingThread(shell.id) &&
      !isShownUnderParent(
        { environmentId: shell.environmentId, threadId: shell.id },
        shell.lineage,
        delegatedUnderParent,
      ),
  );
  const grouped = groupWorkThreads(
    listed,
    live.filter((shell) => shell.feature?.member !== undefined),
  );
  // Unscoped, so a child feature in another project folds under its parent's row there too.
  const { primaries } = nestChildFeatureGroups(grouped.primaries, grouped.groupByThreadKey);
  return new Set([
    ...primaries.map(shellKey),
    ...live.filter((shell) => isStandingThread(shell.id)).map(shellKey),
  ]);
}

/**
 * A thread's activity: working from any thread, failed and unread only from one the list shows
 * (`isRow`), so a thread nobody can open never keeps a dot lit. Null when it has none. Runs on
 * every streamed update, so the row lookup waits until there is something unseen.
 */
function shellActivity<Shell extends BotActivityShell>(
  shell: Shell,
  isRow: (shell: Shell) => boolean,
): BotActivity | null {
  const working = isThreadWorking(shell);
  // A server without visit tracking never reads as unseen.
  const visits = shell.lastVisitedAt !== undefined;
  const failed = visits && hasUnseenFailure(shell);
  const unread = visits && hasUnseenCompletion(shell);
  if ((failed || unread) && isRow(shell)) return { failed, working, unread };
  return working ? { failed: false, working, unread: false } : null;
}

/**
 * Activity per environment's bot, keyed by `botNeedsYouKey`. Bots with nothing going on are
 * left out. Failed and unread come only from list rows (`listRowThreadKeys`); a project
 * manager's thread counts for its manager.
 */
export function botActivityByBot(
  shells: ReadonlyArray<BotActivityShell>,
  projects: ReadonlyArray<BotOwnedProject>,
  rowKeys: ReadonlySet<string>,
): ReadonlyMap<string, BotActivity> {
  const ownerKey = createThreadBotKeyResolver(projects);
  const isRow = (shell: BotActivityShell) =>
    headquartersProjectId(shell.id) === null && rowKeys.has(shellKey(shell));
  const activity = new Map<string, BotActivity>();
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const next = shellActivity(shell, isRow);
    if (next === null) continue;
    const key = ownerKey(shell);
    if (key === undefined) continue;
    activity.set(key, mergeActivity(activity.get(key), next));
  }
  return activity;
}

/**
 * Activity per project, keyed by `${environmentId}:${projectId}`, for project managers: the
 * project's list rows (`listRowThreadKeys`) and its manager's thread.
 */
export function activityByProject(
  shells: ReadonlyArray<BotActivityShell>,
  rowKeys: ReadonlySet<string>,
): ReadonlyMap<string, BotActivity> {
  const isRow = (shell: BotActivityShell) => rowKeys.has(shellKey(shell));
  const activity = new Map<string, BotActivity>();
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const next = shellActivity(shell, isRow);
    if (next === null) continue;
    const key = `${shell.environmentId}:${shell.projectId}`;
    activity.set(key, mergeActivity(activity.get(key), next));
  }
  return activity;
}

/** A project manager's activity over its project group's `${environmentId}:${projectId}` keys. */
export function activityForProjects(
  activity: ReadonlyMap<string, BotActivity>,
  projectKeys: Iterable<string>,
): BotActivity | undefined {
  let merged: BotActivity | undefined;
  for (const key of projectKeys) {
    const next = activity.get(key);
    if (next !== undefined) merged = mergeActivity(merged, next);
  }
  return merged;
}

/** A project manager's asks over its project group's `${environmentId}:${projectId}` keys. */
export function needsYouForProjects(
  counts: ReadonlyMap<string, number>,
  projectKeys: Iterable<string>,
): number {
  let total = 0;
  for (const key of projectKeys) total += counts.get(key) ?? 0;
  return total;
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

interface ManagedProject {
  readonly environmentId: EnvironmentId;
  readonly managerPinned?: boolean | undefined;
  readonly remoteManager?: ProjectRemoteManager | null | undefined;
  readonly isScratch?: true;
  readonly isBotHome?: true;
}

/**
 * Whether a project has its own manager: not Scratch or a bot's home, on an environment with
 * features (`managerEnvironmentIds`), and not a copy whose manager lives on another machine.
 */
export const projectHasManager = (
  project: ManagedProject,
  managerEnvironmentIds: ReadonlySet<EnvironmentId>,
): boolean =>
  !project.isScratch &&
  !project.isBotHome &&
  project.remoteManager == null &&
  managerEnvironmentIds.has(project.environmentId);

/**
 * Asks only the Bots place shows: an unpinned bot's or unpinned manager's, that no pinned entry
 * shows. A pinned bot shows its threads but not its managers' threads; a pinned manager shows
 * every thread in its projects (`managedProjectKeys`, by `${environmentId}:${projectId}`).
 */
export function countHiddenNeedsYou(input: {
  readonly bots: ReadonlyArray<LogicalBot>;
  readonly shells: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly projectId: ProjectId;
  }>;
  readonly projects: ReadonlyArray<BotOwnedProject & ManagedProject>;
  readonly managedProjectKeys: ReadonlySet<string>;
  readonly managerEnvironmentIds: ReadonlySet<EnvironmentId>;
}): number {
  const pinnedBots = new Set<string>();
  for (const bot of input.bots) {
    if (!bot.pinned) continue;
    for (const member of bot.members) {
      pinnedBots.add(botNeedsYouKey(member.environmentId, member.botId));
    }
  }
  const unpinnedManagers = new Set(
    input.projects
      .filter(
        (project) =>
          !isManagerPinned(project) && projectHasManager(project, input.managerEnvironmentIds),
      )
      .map((project) => `${project.environmentId}:${project.id}`),
  );
  const ownerKey = createThreadBotKeyResolver(input.projects);
  let count = 0;
  for (const shell of input.shells) {
    const projectKey = `${shell.environmentId}:${shell.projectId}`;
    if (input.managedProjectKeys.has(projectKey)) continue;
    // A bot never shows its project managers' threads.
    const owner = headquartersProjectId(shell.id) === null ? ownerKey(shell) : undefined;
    if (owner !== undefined && pinnedBots.has(owner)) continue;
    if (owner !== undefined || unpinnedManagers.has(projectKey)) count += 1;
  }
  return count;
}

/**
 * Pinned project managers the rail lists, by title: one per project whose manager is pinned,
 * whether or not its thread exists yet (opening it makes one). Scratch, bots' homes, servers
 * without features, managers turned off (their thread archived) and copies whose manager lives
 * on another machine are left out.
 */
export function pinnedProjectManagers<
  Project extends {
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
    readonly title: string;
    readonly managerPinned?: boolean | undefined;
    readonly remoteManager?: ProjectRemoteManager | null | undefined;
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
        isManagerPinned(project) &&
        projectHasManager(project, input.managerEnvironmentIds) &&
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
