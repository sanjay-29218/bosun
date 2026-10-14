import { useAtomSet, useAtomValue } from "@effect/atom-react";
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
import { useCallback, useMemo } from "react";

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

const EMPTY_ACTIVE_BOTS: Readonly<Record<string, string>> = {};

export interface ActiveBot {
  /** Every logical bot; the switcher shows only when there are two or more. */
  readonly bots: ReadonlyArray<LogicalBot>;
  readonly active: LogicalBot | null;
  readonly needsYou: ReadonlyMap<string, number>;
  /**
   * `environmentId:projectId` keys of the active bot's projects, or null to show every
   * project (one bot, or none yet).
   */
  readonly projectKeys: ReadonlySet<string> | null;
  /** Where List / Board is remembered: the active bot, or "all" without a switcher. */
  readonly viewKey: string;
  readonly select: (bot: LogicalBot) => void;
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
    (bot: LogicalBot) =>
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
