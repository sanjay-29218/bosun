import { useAtomValue } from "@effect/atom-react";
import {
  activityByProject,
  botListEnvironmentIds,
  botActivityByBot,
  botActivityByLogicalBot,
  buildConnectedLogicalBots,
  buildLogicalBots,
  countHiddenNeedsYou,
  countNeedsYouByLogicalBot,
  listRowThreadKeys,
  logicalBotsSignature,
  logicalBotHeadquartersKeys,
  railProjectKeys,
  railBotsSettled,
  resolveSidebarLayout,
  resolveActiveLogicalBot,
  resolveEnvironmentFilter,
  selectLogicalBot,
  type BotActivity,
  type LogicalBot,
  type RailBotSource,
} from "@t3tools/client-runtime/state/bot-rail";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  countNeedsYouByBot,
  countNeedsYouByProject,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useSettingsProjectGroups } from "../components/settings/useSettingsProjectGroups";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useClientSettings } from "../hooks/useSettings";
import { useUiStateStore } from "../uiStateStore";
import { botsEnvironment } from "./bots";
import { useConnectedEnvironmentIds } from "./environments";
import { environmentSummaries } from "./presentation";
import { environmentProjects } from "./projects";
import { needsYouThreadsAtom } from "./needsYou";
import { expectsPrimaryEnvironment } from "./shell";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

const sameIds = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** Environments whose server has bots, primary first. */
const botEnvironmentIdsAtom = Atom.make((get): ReadonlyArray<EnvironmentId> => {
  const primary = get(primaryEnvironmentIdAtom);
  const next = [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.bots === true)
    .map(([environmentId]) => environmentId)
    .sort((left, right) => (left === primary ? -1 : right === primary ? 1 : 0));
  const previous = Option.getOrNull(get.self<ReadonlyArray<EnvironmentId>>());
  return previous !== null && sameIds(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-bot-rail:environments"));

// A machine whose first attempt, config or bot list stalls mustn't hide the thread list: rows
// show in the layout known by then this long after the sidebar first asks. Bots land about 1s after
// it mounts locally; the margin covers slower machines, where firing early would switch layouts.
const BOTS_WAIT_MS = 4_000;

const botsWaitOverAtom = Atom.make((get): boolean => {
  if (Option.getOrElse(get.self<boolean>(), () => false)) return true;
  const timer = setTimeout(() => get.setSelf(true), BOTS_WAIT_MS);
  get.addFinalizer(() => clearTimeout(timer));
  return false;
}).pipe(Atom.keepAlive, Atom.withLabel("web-bot-rail:wait-over"));

// Kept alive so a later machine's connection can't reset it while the thread list is away.
const botListsSettledAtom = Atom.make((get): boolean => {
  const settled = Option.getOrElse(get.self<boolean>(), () => false);
  // Reading nothing once settled lets the bot-list queries idle out.
  if (settled || get(botsWaitOverAtom)) return true;
  // Before primary discovery the catalog proves nothing; a hosted app's can be truly empty.
  const catalog = get(environmentCatalog.catalogValueAtom);
  if (
    !catalog.isReady ||
    (expectsPrimaryEnvironment() &&
      ![...catalog.entries.values()].some(
        (entry) => entry.target._tag === "PrimaryConnectionTarget",
      ))
  ) {
    return false;
  }
  const configs = get(environmentServerConfigsAtom);
  // A filter that leaves this machine out could narrow to hide its bot once others connect.
  const selected = useUiStateStore.getState().sidebarEnvironmentIds;
  const machines = get(environmentSummaries.environmentsAtom).map(
    ({ environmentId, isEnabled, connectionState }): RailBotSource => {
      const config = configs.get(environmentId);
      const bots =
        config?.environment.capabilities.bots === true
          ? get(botsEnvironment.list({ environmentId, input: {} }))
          : null;
      const loaded = bots === null ? null : Option.getOrNull(AsyncResult.value(bots));
      return {
        connection: !isEnabled
          ? "unreachable"
          : connectionState === "connected" || connectionState === "connecting"
            ? connectionState
            : "unreachable",
        configured: config !== undefined,
        bots:
          bots === null
            ? "none"
            : AsyncResult.isInitial(bots)
              ? "loading"
              : loaded?.some((bot) => bot.pinned ?? true) &&
                  (selected === null || selected.length === 0 || selected.includes(environmentId))
                ? "shown"
                : "loaded",
      };
    },
  );
  return railBotsSettled(settled, machines);
}).pipe(Atom.keepAlive, Atom.withLabel("web-bot-rail:lists-settled"));

/**
 * Rail entries: connected environments' bots, behind the rail, the active bot, pins and activity.
 * The same array returns until one changes.
 */
export const logicalBotsAtom = Atom.make((get): ReadonlyArray<LogicalBot> => {
  const environments = get(botEnvironmentIdsAtom).flatMap((environmentId) => {
    const bots = Option.getOrNull(
      AsyncResult.value(get(botsEnvironment.list({ environmentId, input: {} }))),
    );
    return bots ? [{ environmentId, bots }] : [];
  });
  const next = buildConnectedLogicalBots(
    environments,
    get(environmentSummaries.connectedEnvironmentIdsAtom),
  );
  const previous = Option.getOrNull(get.self<ReadonlyArray<LogicalBot>>());
  return previous !== null && logicalBotsSignature(previous) === logicalBotsSignature(next)
    ? previous
    : next;
}).pipe(Atom.withLabel("web-bot-rail:logical-bots"));

interface BotListEnvironment {
  readonly environmentId: EnvironmentId;
  readonly online: boolean;
}
interface BotListState {
  readonly environments: ReadonlyArray<BotListEnvironment>;
  readonly bots: ReadonlyArray<LogicalBot>;
}
/**
 * What the bot lists show, apart from the rail: every bot environment that is connected, then
 * known environments that aren't, with the bots they had when last seen.
 */
const botListAtom = Atom.make((get): BotListState => {
  const connected = get(environmentSummaries.connectedEnvironmentIdsAtom);
  const listed = botListEnvironmentIds({
    botEnvironmentIds: get(botEnvironmentIdsAtom),
    knownEnvironmentIds: [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))],
    connectedEnvironmentIds: connected,
  }).flatMap((environmentId) => {
    const bots = Option.getOrNull(
      AsyncResult.value(get(botsEnvironment.list({ environmentId, input: {} }))),
    );
    return bots ? [{ environmentId, bots, online: connected.includes(environmentId) }] : [];
  });
  const environments = listed.map(({ environmentId, online }) => ({ environmentId, online }));
  const bots = buildLogicalBots(listed);
  const previous = Option.getOrNull(get.self<BotListState>());
  const value: BotListState = { environments, bots };
  return previous !== null &&
    logicalBotsSignature(previous.bots) === logicalBotsSignature(bots) &&
    sameIds(
      previous.environments.map((entry) => `${entry.environmentId}:${entry.online}`),
      environments.map((entry) => `${entry.environmentId}:${entry.online}`),
    )
    ? previous
    : value;
}).pipe(Atom.withLabel("web-bot-rail:bot-list"));

const sameCounts = (left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>) =>
  left.size === right.size && [...right].every(([key, count]) => left.get(key) === count);

/** Asks waiting on you per environment's bot, keyed by `botNeedsYouKey`. */
const needsYouByBotAtom = Atom.make((get): ReadonlyMap<string, number> => {
  const next = countNeedsYouByBot(get(needsYouThreadsAtom), get(environmentProjects.projectsAtom));
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, number>>());
  return previous !== null && sameCounts(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-bot-rail:needs-you"));

/** Asks waiting on you per project, keyed by `${environmentId}:${projectId}`, for managers. */
const needsYouByProjectAtom = Atom.make((get): ReadonlyMap<string, number> => {
  const next = countNeedsYouByProject(get(needsYouThreadsAtom));
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, number>>());
  return previous !== null && sameCounts(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-bot-rail:needs-you-by-project"));

const sameActivity = (left: BotActivity, right: BotActivity) =>
  left.failed === right.failed && left.working === right.working && left.unread === right.unread;

const sameActivityMap = (
  left: ReadonlyMap<string, BotActivity>,
  right: ReadonlyMap<string, BotActivity>,
) =>
  left.size === right.size &&
  [...right].every(([key, activity]) => {
    const before = left.get(key);
    return before !== undefined && sameActivity(before, activity);
  });

/**
 * Threads that are their own row in a thread list (`listRowThreadKeys`). Read from quiet shells,
 * which leave out hidden-tag threads and skip streamed updates, so grouping reruns only when the
 * list's shape changes.
 */
const listRowKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const next = listRowThreadKeys(
    get(environmentThreadShells.quietThreadShellsAtom),
    get(environmentThreadShells.delegatedUnderParentAtom),
  );
  const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every((key) => previous.has(key))
    ? previous
    : next;
}).pipe(Atom.withLabel("web-bot-rail:list-rows"));

/**
 * Failed, working and unread threads per environment's bot, keyed by `botNeedsYouKey`. Shells
 * stream while agents work, so the same map returns until a flag flips.
 */
const activityByBotAtom = Atom.make((get): ReadonlyMap<string, BotActivity> => {
  const next = botActivityByBot(
    get(environmentThreadShells.threadShellsAtom),
    get(environmentProjects.projectsAtom),
    get(listRowKeysAtom),
  );
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, BotActivity>>());
  return previous !== null && sameActivityMap(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-bot-rail:activity"));

/** `activityByBotAtom` per project, keyed by `${environmentId}:${projectId}`, for managers. */
const activityByProjectAtom = Atom.make((get): ReadonlyMap<string, BotActivity> => {
  const next = activityByProject(
    get(environmentThreadShells.threadShellsAtom),
    get(listRowKeysAtom),
  );
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, BotActivity>>());
  return previous !== null && sameActivityMap(previous, next) ? previous : next;
}).pipe(Atom.withLabel("web-bot-rail:activity-by-project"));

/** Asks per project, keyed by `${environmentId}:${projectId}`; managers sum their group's. */
export function useNeedsYouByProject(): ReadonlyMap<string, number> {
  return useAtomValue(needsYouByProjectAtom);
}

/** Activity per project, keyed by `${environmentId}:${projectId}`; managers merge their group's. */
export function useActivityByProject(): ReadonlyMap<string, BotActivity> {
  return useAtomValue(activityByProjectAtom);
}

// Member keys are `botNeedsYouKey`s, so the environment is their prefix.
const onShownEnvironments = <Value>(
  byMember: ReadonlyMap<string, Value>,
  environmentFilter: ReadonlySet<EnvironmentId> | null,
): ReadonlyMap<string, Value> =>
  environmentFilter === null
    ? byMember
    : new Map(
        [...byMember].filter(([memberKey]) =>
          [...environmentFilter].some((environmentId) => memberKey.startsWith(`${environmentId}:`)),
        ),
      );

/** Threads waiting on you per rail entry key, on the environments the filter shows. */
export function useNeedsYouByLogicalBot(): ReadonlyMap<string, number> {
  const counts = useAtomValue(needsYouByBotAtom);
  const bots = useLogicalBots();
  const environmentFilter = useEnvironmentFilter();
  return countNeedsYouByLogicalBot(bots, onShownEnvironments(counts, environmentFilter));
}

/** Activity per rail entry key, on the environments the filter shows. */
export function useActivityByLogicalBot(): ReadonlyMap<string, BotActivity> {
  const activity = useAtomValue(activityByBotAtom);
  const bots = useLogicalBots();
  const environmentFilter = useEnvironmentFilter();
  return botActivityByLogicalBot(bots, onShownEnvironments(activity, environmentFilter));
}

function useLogicalBots(): ReadonlyArray<LogicalBot> {
  return useAtomValue(logicalBotsAtom);
}

export function useBotEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(botEnvironmentIdsAtom);
}

/** Connected environments with bots, primary first, whatever the sidebar filter shows. */
export function useConnectedBotEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const environmentIds = useBotEnvironmentIds();
  const connected = useConnectedEnvironmentIds();
  return environmentIds.filter((environmentId) => connected.includes(environmentId));
}

/** Connected environments with bots that the sidebar shows, primary first. */
export function useShownBotEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const environmentIds = useBotEnvironmentIds();
  const connected = useConnectedEnvironmentIds();
  const environmentFilter = useEnvironmentFilter();
  return environmentIds.filter(
    (environmentId) =>
      connected.includes(environmentId) &&
      (environmentFilter === null || environmentFilter.has(environmentId)),
  );
}

const onShownEnvironment = (
  bots: ReadonlyArray<LogicalBot>,
  environmentFilter: ReadonlySet<EnvironmentId> | null,
) =>
  environmentFilter === null
    ? bots
    : bots.filter((bot) =>
        bot.members.some((member) => environmentFilter.has(member.environmentId)),
      );

// The rail, its shortcuts and the thread list's bot scope cover pinned bots only.
const visibleLogicalBots = (
  bots: ReadonlyArray<LogicalBot>,
  environmentFilter: ReadonlySet<EnvironmentId> | null,
) => onShownEnvironment(bots, environmentFilter).filter((bot) => bot.pinned);

function readActiveLogicalBot(): LogicalBot | null {
  const { activeBotIdByEnvironmentId, botRailShowsProjects, sidebarEnvironmentIds } =
    useUiStateStore.getState();
  if (botRailShowsProjects) return null;
  const environmentFilter = resolveEnvironmentFilter(
    sidebarEnvironmentIds,
    appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom),
  );
  return resolveActiveLogicalBot(
    visibleLogicalBots(appAtomRegistry.get(logicalBotsAtom), environmentFilter),
    activeBotIdByEnvironmentId,
    appAtomRegistry.get(botEnvironmentIdsAtom),
  );
}

/**
 * Makes the rail entry holding `botId` on `environmentId` the active one. A headquarters can open
 * from the palette, the Bots page or a link, and the sidebar should follow the bot it belongs to.
 */
export function selectBotOfHeadquarters(environmentId: EnvironmentId, botId: string): void {
  const bot = appAtomRegistry
    .get(logicalBotsAtom)
    .find((candidate) =>
      candidate.members.some(
        (member) => member.environmentId === environmentId && member.botId === botId,
      ),
    );
  if (!bot || readActiveLogicalBotKey() === bot.key) return;
  useUiStateStore.getState().setActiveBotIdByEnvironmentId(selectLogicalBot(bot));
}

/** The active rail entry's key, read outside React (the main view is remembered per bot). */
export function readActiveLogicalBotKey(): string | null {
  return readActiveLogicalBot()?.key ?? null;
}

/** Where the rail remembers its pages: the active bot, else the Projects entry. */
export const PROJECTS_RAIL_KEY = "projects";
export function readRailSelectionKey(): string {
  return readActiveLogicalBotKey() ?? PROJECTS_RAIL_KEY;
}

/**
 * Spread into a project create input: the active bot's copy on `environmentId` owns the new
 * project; with no active bot there, the project has no bot.
 */
export function activeBotInput(environmentId: EnvironmentId): { botId?: string } {
  const botId = readActiveLogicalBot()?.members.find(
    (member) => member.environmentId === environmentId,
  )?.botId;
  return botId === undefined ? {} : { botId };
}

/** Selects a rail entry. */
export function useSelectLogicalBot(): (bot: LogicalBot) => void {
  const setActive = useUiStateStore((store) => store.setActiveBotIdByEnvironmentId);
  return (bot) => setActive(selectLogicalBot(bot));
}

/** The environments the rail and sidebar show, or null for all of them. */
export function useEnvironmentFilter(): ReadonlySet<EnvironmentId> | null {
  const selected = useUiStateStore((store) => store.sidebarEnvironmentIds);
  const connected = useConnectedEnvironmentIds();
  return resolveEnvironmentFilter(selected, connected);
}

/** Every bot the environment filter leaves visible, pinned or not, for the Bots list. */
export function useAllVisibleLogicalBots(): ReadonlyArray<LogicalBot> {
  const bots = useLogicalBots();
  const environmentFilter = useEnvironmentFilter();
  return onShownEnvironment(bots, environmentFilter);
}

/**
 * Every bot for the Bots lists, across connected and offline environments the filter leaves
 * visible, with each environment's machine name when several are known.
 */
export function useBotList(): BotListState & {
  readonly machineOf: (environmentId: EnvironmentId) => string | null;
  readonly isOnline: (environmentId: EnvironmentId) => boolean;
} {
  const list = useAtomValue(botListAtom);
  const environmentFilter = useEnvironmentFilter();
  const identities = useAtomValue(environmentSummaries.identitiesAtom);
  const shown = (environmentId: EnvironmentId) =>
    environmentFilter === null || environmentFilter.has(environmentId);
  const environments = list.environments.filter((entry) => shown(entry.environmentId));
  const several = environments.length > 1;
  return {
    bots: list.bots.filter((bot) => bot.members.some((member) => shown(member.environmentId))),
    environments,
    machineOf: (environmentId) =>
      several
        ? (identities.find((identity) => identity.environmentId === environmentId)?.label ?? null)
        : null,
    isOnline: (environmentId) =>
      list.environments.some((entry) => entry.environmentId === environmentId && entry.online),
  };
}

/**
 * Pinned rail entries the environment filter leaves visible: an entry shows while one of its
 * environments does.
 */
export function useVisibleLogicalBots(): ReadonlyArray<LogicalBot> {
  const bots = useLogicalBots();
  const environmentFilter = useEnvironmentFilter();
  return visibleLogicalBots(bots, environmentFilter);
}

/**
 * The active entry among the visible ones, null only while none is visible. Filtering out its
 * environments falls back to the first visible bot without forgetting what each environment
 * remembers.
 */
export function useVisibleActiveLogicalBot(): LogicalBot | null {
  const bots = useVisibleLogicalBots();
  const environmentIds = useBotEnvironmentIds();
  const remembered = useUiStateStore((store) => store.activeBotIdByEnvironmentId);
  const showsProjects = useUiStateStore((store) => store.botRailShowsProjects);
  return showsProjects ? null : resolveActiveLogicalBot(bots, remembered, environmentIds);
}

/** The thread list's layout; pending until it is known, so rows first show where they stay. */
export function useSidebarLayout() {
  const showsRail = useShowBotRail();
  const projectsPicked = useUiStateStore((store) => store.botRailShowsProjects);
  const hasActiveBot = useVisibleActiveLogicalBot() !== null;
  const botsSettled = useAtomValue(botListsSettledAtom);
  const foldersSetting = useClientSettings((settings) => settings.boringSidebarEnabled);
  return resolveSidebarLayout({
    botsSettled,
    projectsPicked,
    showsRail,
    hasActiveBot,
    foldersSetting,
  });
}

/**
 * The rail holds the app's places too, Bots among them, so it shows wherever bots can run or
 * there is a second environment.
 */
export function useShowBotRail(): boolean {
  const botEnvironmentCount = useBotEnvironmentIds().length;
  const environmentCount = useConnectedEnvironmentIds().length;
  return botEnvironmentCount > 0 || environmentCount > 1;
}

/**
 * Asks no pinned bot or manager shows. `managedProjectKeys` are the projects the rail's pinned
 * managers show, by `${environmentId}:${projectId}`.
 */
export function useHiddenNeedsYouCount(managedProjectKeys: ReadonlySet<string>): number {
  const bots = useLogicalBots();
  const shells = useAtomValue(needsYouThreadsAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const environmentFilter = useEnvironmentFilter();
  return countHiddenNeedsYou({
    bots,
    projects,
    managedProjectKeys,
    // Servers with features have project managers.
    managerEnvironmentIds: new Set(
      [...serverConfigs]
        .filter(([, config]) => config.environment.capabilities.workflows === true)
        .map(([environmentId]) => environmentId),
    ),
    shells:
      environmentFilter === null
        ? shells
        : shells.filter((shell) => environmentFilter.has(shell.environmentId)),
  });
}

/**
 * `${environmentId}:${threadId}` keys of the picked bot's headquarters, or null when the rail
 * isn't narrowing to one bot. Pass it to `botRailShowsThread` with the project keys.
 */
export function useBotRailHeadquartersKeys(): ReadonlySet<string> | null {
  const active = useVisibleActiveLogicalBot();
  const environmentFilter = useEnvironmentFilter();
  return active === null ? null : logicalBotHeadquartersKeys(active, environmentFilter);
}

/**
 * `${environmentId}:${projectId}` keys of the projects the sidebar and board show for the
 * active bot and environment filter, or null when nothing is filtered.
 */
export function useBotRailProjectKeys(): ReadonlySet<string> | null {
  const allBots = useAllVisibleLogicalBots();
  const active = useVisibleActiveLogicalBot();
  const environmentFilter = useEnvironmentFilter();
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const scopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const groups = useSettingsProjectGroups();
  const scopedProjects = groups
    .filter((group) => scopeKeys.includes(group.projectKey))
    .flatMap((group) => group.memberProjects);
  return railProjectKeys({
    active,
    allBots,
    projects,
    environmentFilter,
    scopedProjects,
  });
}

/**
 * A bot switch in thread view asks for that bot's first thread. Only the sidebar knows its order
 * once it shows the bot, so it opens the thread and clears this. A null bot key is no bot yet.
 */
export const botFirstThreadRequestAtom = Atom.make<{ readonly botKey: string | null } | null>(
  null,
).pipe(Atom.keepAlive, Atom.withLabel("bot-rail:first-thread-request"));

export function requestBotFirstThread(botKey: string | null): void {
  appAtomRegistry.set(botFirstThreadRequestAtom, { botKey });
}

export function clearBotFirstThreadRequest(): void {
  appAtomRegistry.set(botFirstThreadRequestAtom, null);
}
