import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  threadBoardSignal,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import { createFeatureAtoms } from "@t3tools/client-runtime/state/features";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState } from "react-native";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentProjects } from "./projects";
import { formatEnvironmentQueryError } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

export interface FeatureBoardTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const boardKey = (target: FeatureBoardTarget) =>
  JSON.stringify([target.environmentId, target.projectId]);

/** Every project's board signal, keyed by `boardKey`, computed once per shell update. */
const boardSignalsAtom = Atom.make((get) => {
  const parts = new Map<string, string[]>();
  for (const thread of get(environmentThreadShells.threadShellsAtom)) {
    if (thread.archivedAt !== null) continue;
    const key = boardKey({ environmentId: thread.environmentId, projectId: thread.projectId });
    const list = parts.get(key) ?? [];
    list.push(threadBoardSignal(thread));
    parts.set(key, list);
  }
  return new Map([...parts].map(([key, list]) => [key, [...list].sort().join(",")]));
}).pipe(Atom.withLabel("feature-board-signals"));

/**
 * Changes when a thread in the project starts, stops, or starts waiting on you. Starting a
 * feature makes its lead's thread, so a board that is on screen re-reads then instead of polling.
 */
const boardSignalAtom = Atom.family((key: string) =>
  Atom.make((get) => get(boardSignalsAtom).get(key) ?? "").pipe(
    Atom.withLabel(`feature-board-signal:${key}`),
  ),
);

export const featuresEnvironment = createFeatureAtoms(connectionAtomRuntime, {
  boardRefreshTrigger: ({ environmentId, input }) =>
    boardSignalAtom(boardKey({ environmentId, projectId: input.projectId })),
});

const boardAtom = (target: FeatureBoardTarget) =>
  featuresEnvironment.board({
    environmentId: target.environmentId,
    input: { projectId: target.projectId },
  });

/** Projects on environments whose server runs features. */
export const crewProjectsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  return get(environmentProjects.projectsAtom).filter(
    (project) => configs.get(project.environmentId)?.environment.capabilities.workflows === true,
  );
}).pipe(Atom.withLabel("crew-projects"));

/** Feature projects the board can show: the active bot's, or every one without a switcher. */
export function useBoardProjects(
  botProjectKeys: ReadonlySet<string> | null,
): ReadonlyArray<EnvironmentProject> {
  const projects = useAtomValue(crewProjectsAtom);
  return useMemo(
    () =>
      botProjectKeys === null
        ? projects
        : projects.filter((project) =>
            botProjectKeys.has(`${project.environmentId}:${project.id}`),
          ),
    [botProjectKeys, projects],
  );
}

/** How often an on-screen board re-reads a server too old to say when features change. */
const ACTIVE_BOARD_REFRESH_MS = 30_000;

/**
 * Each environment's feature count (`crewUpdated`), which moves when a feature's own record
 * changes, such as another device closing one. `none` for servers that don't send it.
 */
const featureRevisionsAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom)]
    .map(([environmentId, config]) => `${environmentId}=${config.crewRevision?.features ?? "none"}`)
    .sort()
    .join(";"),
).pipe(Atom.withLabel("mobile-features:feature-revisions"));

/**
 * The server-built board cards of every target, merged. Each project loads and fails on its
 * own. While `active` (on screen, app in the foreground) boards re-read on arrival and when
 * their environment's feature count moves: closing or reopening a feature on another device
 * moves no thread here, so the thread signal alone would miss it. Older servers are polled.
 */
export function useFeatureBoard(targets: ReadonlyArray<FeatureBoardTarget>, active: boolean) {
  const registry = useContext(RegistryContext);
  const key = JSON.stringify(targets.map(boardKey));
  // Callers rebuild `targets` every render; the key is what identifies the set.
  const [stable, setStable] = useState({ key, targets });
  if (stable.key !== key) setStable({ key, targets });
  const stableTargets = stable.key === key ? stable.targets : targets;
  const resultsAtom = useMemo(
    () =>
      Atom.make((get) =>
        stableTargets.map((target) => ({ target, result: get(boardAtom(target)) })),
      ).pipe(Atom.withLabel(`feature-board:${key}`)),
    [key, stableTargets],
  );
  const results = useAtomValue(resultsAtom);
  const featureRevisions = useAtomValue(featureRevisionsAtom);
  const polled = featureRevisions.split(";").some((entry) => entry.endsWith("=none"));

  const refresh = useCallback(() => {
    for (const target of stableTargets) registry.refresh(boardAtom(target));
  }, [registry, stableTargets]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- re-reads boards on arrival, foregrounding and feature-count changes while on screen, polling only older servers; all torn down on hide or unmount.
  useEffect(() => {
    if (!active || stableTargets.length === 0) return undefined;
    refresh();
    const timer = polled
      ? setInterval(() => {
          if (AppState.currentState === "active") refresh();
        }, ACTIVE_BOARD_REFRESH_MS)
      : undefined;
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      if (timer !== undefined) clearInterval(timer);
      subscription.remove();
    };
  }, [active, refresh, stableTargets.length, polled]);

  const previousRevisions = useRef<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches on-screen boards from the server when their environments' feature counts move.
  useEffect(() => {
    const previous = previousRevisions.current;
    previousRevisions.current = featureRevisions;
    if (active && previous !== null && previous !== featureRevisions) refresh();
  }, [active, featureRevisions, refresh]);

  return useMemo(() => {
    const cards: EnvironmentFeatureCard[] = [];
    const errors: string[] = [];
    let pending = false;
    for (const { target, result } of results) {
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) {
        for (const card of value) cards.push({ ...card, environmentId: target.environmentId });
      }
      if (result.waiting && value === null) pending = true;
      if (result._tag === "Failure" && !Cause.hasInterruptsOnly(result.cause))
        errors.push(formatEnvironmentQueryError(result.cause));
    }
    return { cards, errors, pending, refresh };
  }, [refresh, results]);
}
