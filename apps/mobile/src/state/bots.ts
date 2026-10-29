import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  buildLogicalBots,
  countNeedsYouByLogicalBot,
  logicalBotProjectKeys,
  resolveActiveLogicalBot,
  selectLogicalBot,
  type LogicalBot,
} from "@t3tools/client-runtime/state/bot-rail";
import { createBotsAtoms } from "@t3tools/client-runtime/state/bots";
import { countNeedsYouByBot } from "@t3tools/client-runtime/state/crew-board";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useContext, useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "./preferences";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

export const botsEnvironment = createBotsAtoms(connectionAtomRuntime);

/** Environments whose server has top-level bots, in connection order, as a stable key. */
const botEnvironmentIdsKeyAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.bots === true)
    .map(([environmentId]) => environmentId)
    .join(","),
).pipe(Atom.withLabel("mobile-bots:environments"));

const botEnvironmentIds = (key: string) =>
  key ? key.split(",").map((environmentId) => EnvironmentId.make(environmentId)) : [];

/** Bots of every connected environment, merged the way web's rail merges them. */
const logicalBotsAtom = Atom.make((get) =>
  buildLogicalBots(
    botEnvironmentIds(get(botEnvironmentIdsKeyAtom)).map((environmentId) => ({
      environmentId,
      bots: Option.getOrElse(
        AsyncResult.value(get(botsEnvironment.list({ environmentId, input: {} }))),
        () => [],
      ),
    })),
  ),
).pipe(Atom.withLabel("mobile-bots:logical"));

/**
 * Threads waiting on you per logical bot, as a sorted `key=count` string so streamed thread
 * updates that change no count re-render nothing.
 */
const needsYouByBotKeyAtom = Atom.make((get) => {
  const counts = countNeedsYouByLogicalBot(
    get(logicalBotsAtom),
    countNeedsYouByBot(
      get(environmentThreadShells.threadShellsAtom),
      get(environmentProjects.projectsAtom),
    ),
  );
  return [...counts]
    .map(([key, count]) => `${encodeURIComponent(key)}=${count}`)
    .sort()
    .join(",");
}).pipe(Atom.withLabel("mobile-bots:needs-you"));

/**
 * Environments where a project names a bot their loaded list doesn't have, as a stable key:
 * a bot made on another device. A project moving to it arrives as a project update.
 */
const unknownBotEnvironmentsKeyAtom = Atom.make((get) => {
  const known = new Map<string, ReadonlySet<string>>();
  for (const environmentId of botEnvironmentIds(get(botEnvironmentIdsKeyAtom))) {
    const list = AsyncResult.value(get(botsEnvironment.list({ environmentId, input: {} })));
    if (Option.isSome(list)) known.set(environmentId, new Set(list.value.map((bot) => bot.id)));
  }
  const stale = new Set<string>();
  for (const project of get(environmentProjects.projectsAtom)) {
    const botIds = known.get(project.environmentId);
    if (botIds && project.botId !== undefined && !botIds.has(project.botId)) {
      stale.add(project.environmentId);
    }
  }
  return [...stale].sort().join(",");
}).pipe(Atom.withLabel("mobile-bots:unknown"));

/**
 * Bots are fetched, not streamed. Re-read them when the app returns to the foreground (a bot
 * renamed or deleted elsewhere) and when a project names a bot this client hasn't loaded.
 * Mount once per visible thread list.
 */
export function useRefreshBotsWhileOpen() {
  const registry = useContext(RegistryContext);
  const environmentKey = useAtomValue(botEnvironmentIdsKeyAtom);
  const unknownKey = useAtomValue(unknownBotEnvironmentsKeyAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState to re-read bots on foreground; removed on unmount.
  useEffect(() => {
    const refresh = () => {
      for (const environmentId of botEnvironmentIds(environmentKey)) {
        registry.refresh(botsEnvironment.list({ environmentId, input: {} }));
      }
    };
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [environmentKey, registry]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches bots a project names but this client hasn't loaded; a fetch can't run during render.
  useEffect(() => {
    for (const environmentId of botEnvironmentIds(unknownKey)) {
      registry.refresh(botsEnvironment.list({ environmentId, input: {} }));
    }
  }, [registry, unknownKey]);
}

const EMPTY_ACTIVE_BOTS: Readonly<Record<string, string>> = {};

export interface ActiveBot {
  /** Every logical bot; the switcher shows only when there are two or more. */
  readonly bots: ReadonlyArray<LogicalBot>;
  /** Null is All bots, or no bot loaded yet. */
  readonly active: LogicalBot | null;
  readonly needsYou: ReadonlyMap<string, number>;
  /**
   * `environmentId:projectId` keys of the active bot's projects, or null to show every
   * project (one bot, or none yet).
   */
  readonly projectKeys: ReadonlySet<string> | null;
  /** Where List / Board is remembered: the active bot, or "all" for All bots. */
  readonly viewKey: string;
  /** Selects a bot, or All bots for null. */
  readonly select: (bot: LogicalBot | null) => void;
}

/** The active bot's id on `environmentId`, which new projects there go to; none means Captain. */
export function activeBotIdOn(
  activeBot: Pick<ActiveBot, "active">,
  environmentId: EnvironmentId,
): string | undefined {
  return activeBot.active?.members.find((member) => member.environmentId === environmentId)?.botId;
}

/** The bot the thread list and board show, remembered per environment. */
export function useActiveBot(): ActiveBot {
  const bots = useAtomValue(logicalBotsAtom);
  const environmentKey = useAtomValue(botEnvironmentIdsKeyAtom);
  const needsYouKey = useAtomValue(needsYouByBotKeyAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const remembered = AsyncResult.isSuccess(preferences)
    ? (preferences.value.activeBotIdByEnvironmentId ?? EMPTY_ACTIVE_BOTS)
    : EMPTY_ACTIVE_BOTS;

  const active = useMemo(
    () => resolveActiveLogicalBot(bots, remembered, botEnvironmentIds(environmentKey)),
    [bots, environmentKey, remembered],
  );
  const needsYou = useMemo(
    () =>
      new Map(
        needsYouKey
          ? needsYouKey.split(",").map((entry) => {
              const [key, count] = entry.split("=");
              return [decodeURIComponent(key!), Number(count)] as const;
            })
          : [],
      ),
    [needsYouKey],
  );
  const switching = bots.length > 1 && active !== null;
  const projectKeys = useMemo(
    () => (switching ? logicalBotProjectKeys(active, bots, projects) : null),
    [active, bots, projects, switching],
  );
  const select = useCallback(
    (bot: LogicalBot | null) =>
      savePreferences({
        transform: (current) => ({
          activeBotIdByEnvironmentId: selectLogicalBot(
            current.activeBotIdByEnvironmentId ?? {},
            bot,
          ),
        }),
      }),
    [savePreferences],
  );

  return useMemo(
    () => ({
      bots,
      active,
      needsYou,
      projectKeys,
      viewKey: switching ? active.key : "all",
      select,
    }),
    [active, bots, needsYou, projectKeys, select, switching],
  );
}
