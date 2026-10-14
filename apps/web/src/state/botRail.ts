import { useAtomValue } from "@effect/atom-react";
import {
  buildLogicalBots,
  countNeedsYouByLogicalBot,
  logicalBotHeadquartersKeys,
  logicalBotProjectKeys,
  resolveActiveLogicalBot,
  resolveEnvironmentFilter,
  selectLogicalBot,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import { countNeedsYouByBot } from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useUiStateStore } from "../uiStateStore";
import { botsEnvironment } from "./bots";
import { useConnectedEnvironmentIds } from "./environments";
import { environmentSummaries } from "./presentation";
import { environmentProjects } from "./projects";
import { needsYouThreadsAtom } from "./needsYou";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";

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

const logicalBotsSignature = (bots: ReadonlyArray<LogicalBot>) =>
  bots
    .map(
      (bot) =>
        `${bot.key}|${bot.name}|${JSON.stringify(bot.avatar)}|${bot.color}|${bot.members.map((member) => `${member.environmentId}/${member.botId}`).join(",")}`,
    )
    .join("\n");

/** Rail entries: every environment's bots merged. The same array returns until one changes. */
export const logicalBotsAtom = Atom.make((get): ReadonlyArray<LogicalBot> => {
  const environments = get(botEnvironmentIdsAtom).flatMap((environmentId) => {
    const bots = Option.getOrNull(
      AsyncResult.value(get(botsEnvironment.list({ environmentId, input: {} }))),
    );
    return bots ? [{ environmentId, bots }] : [];
  });
  const next = buildLogicalBots(environments);
  const previous = Option.getOrNull(get.self<ReadonlyArray<LogicalBot>>());
  return previous !== null && logicalBotsSignature(previous) === logicalBotsSignature(next)
    ? previous
    : next;
}).pipe(Atom.withLabel("web-bot-rail:logical-bots"));

/** Threads waiting on you per environment's bot, keyed by `botNeedsYouKey`. */
const needsYouByBotAtom = Atom.make((get): ReadonlyMap<string, number> => {
  const next = countNeedsYouByBot(get(needsYouThreadsAtom), get(environmentProjects.projectsAtom));
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, number>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every(([key, count]) => previous.get(key) === count)
    ? previous
    : next;
}).pipe(Atom.withLabel("web-bot-rail:needs-you"));

/** Threads waiting on you per rail entry key, on the environments the filter shows. */
export function useNeedsYouByLogicalBot(): ReadonlyMap<string, number> {
  const counts = useAtomValue(needsYouByBotAtom);
  const bots = useLogicalBots();
  const environmentFilter = useEnvironmentFilter();
  return useMemo(
    () =>
      countNeedsYouByLogicalBot(
        bots,
        environmentFilter === null
          ? counts
          : new Map(
              [...counts].filter(([memberKey]) =>
                [...environmentFilter].some((environmentId) =>
                  memberKey.startsWith(`${environmentId}:`),
                ),
              ),
            ),
      ),
    [bots, counts, environmentFilter],
  );
}

export function useLogicalBots(): ReadonlyArray<LogicalBot> {
  return useAtomValue(logicalBotsAtom);
}

export function useBotEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  return useAtomValue(botEnvironmentIdsAtom);
}

const visibleLogicalBots = (
  bots: ReadonlyArray<LogicalBot>,
  environmentFilter: ReadonlySet<EnvironmentId> | null,
) =>
  environmentFilter === null
    ? bots
    : bots.filter((bot) =>
        bot.members.some((member) => environmentFilter.has(member.environmentId)),
      );

function readActiveLogicalBot(): LogicalBot | null {
  const { activeBotIdByEnvironmentId, sidebarEnvironmentIds } = useUiStateStore.getState();
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

/** The active rail entry's key, read outside React (the main view is remembered per bot). */
export function readActiveLogicalBotKey(): string | null {
  return readActiveLogicalBot()?.key ?? null;
}

/**
 * Spread into a project create input: the active bot's copy on `environmentId` owns the new
 * project, or the server's Captain when the active bot doesn't exist there.
 */
export function activeBotInput(environmentId: EnvironmentId): { botId?: string } {
  const botId = readActiveLogicalBot()?.members.find(
    (member) => member.environmentId === environmentId,
  )?.botId;
  return botId === undefined ? {} : { botId };
}

export function useSelectLogicalBot(): (bot: LogicalBot) => void {
  const setActive = useUiStateStore((store) => store.setActiveBotIdByEnvironmentId);
  return useCallback(
    (bot) =>
      setActive(selectLogicalBot(useUiStateStore.getState().activeBotIdByEnvironmentId, bot)),
    [setActive],
  );
}

/** The environments the rail and sidebar show, or null for all of them. */
export function useEnvironmentFilter(): ReadonlySet<EnvironmentId> | null {
  const selected = useUiStateStore((store) => store.sidebarEnvironmentIds);
  const connected = useConnectedEnvironmentIds();
  return useMemo(() => resolveEnvironmentFilter(selected, connected), [connected, selected]);
}

/**
 * Rail entries the environment filter leaves visible: an entry shows while one of its
 * environments does.
 */
export function useVisibleLogicalBots(): ReadonlyArray<LogicalBot> {
  const bots = useLogicalBots();
  const environmentFilter = useEnvironmentFilter();
  return useMemo(() => visibleLogicalBots(bots, environmentFilter), [bots, environmentFilter]);
}

/**
 * The active entry among the visible ones. Filtering out its environments falls back to the
 * first visible entry without forgetting what each environment remembers.
 */
export function useVisibleActiveLogicalBot(): LogicalBot | null {
  const bots = useVisibleLogicalBots();
  const environmentIds = useBotEnvironmentIds();
  const remembered = useUiStateStore((store) => store.activeBotIdByEnvironmentId);
  return useMemo(
    () => resolveActiveLogicalBot(bots, remembered, environmentIds),
    [bots, environmentIds, remembered],
  );
}

/** The rail shows once there is a choice to make: two bots, or two connected environments. */
export function useShowBotRail(): boolean {
  const botCount = useLogicalBots().length;
  const environmentCount = useConnectedEnvironmentIds().length;
  return botCount > 1 || environmentCount > 1;
}

/**
 * `${environmentId}:${threadId}` keys of the picked bot's headquarters, or null when the rail
 * isn't narrowing to one bot. Pass it to `botRailShowsThread` with the project keys.
 */
export function useBotRailHeadquartersKeys(): ReadonlySet<string> | null {
  const bots = useVisibleLogicalBots();
  const active = useVisibleActiveLogicalBot();
  const environmentFilter = useEnvironmentFilter();
  return useMemo(
    () =>
      active !== null && bots.length > 1
        ? logicalBotHeadquartersKeys(active, environmentFilter)
        : null,
    [active, bots.length, environmentFilter],
  );
}

/**
 * `${environmentId}:${projectId}` keys of the projects the sidebar and board show for the
 * active bot and environment filter, or null when nothing is filtered.
 */
export function useBotRailProjectKeys(): ReadonlySet<string> | null {
  const bots = useVisibleLogicalBots();
  const active = useVisibleActiveLogicalBot();
  const environmentFilter = useEnvironmentFilter();
  const projects = useAtomValue(environmentProjects.projectsAtom);
  return useMemo(() => {
    const filterByBot = active !== null && bots.length > 1;
    if (!filterByBot && environmentFilter === null) return null;
    const inEnvironment =
      environmentFilter === null
        ? projects
        : projects.filter((project) => environmentFilter.has(project.environmentId));
    if (!filterByBot) {
      return new Set(inEnvironment.map((project) => `${project.environmentId}:${project.id}`));
    }
    return logicalBotProjectKeys(active, bots, inEnvironment);
  }, [active, bots, environmentFilter, projects]);
}
