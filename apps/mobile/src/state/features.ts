import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { crewStageRefreshKey } from "@t3tools/client-runtime/crew-stage";
import {
  threadBoardSignal,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import { createFeatureAtoms } from "@t3tools/client-runtime/state/features";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  CrewStageSummary,
  ProjectId,
  ThreadId,
  WorkflowFeatureSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useContext, useEffect, useMemo, useRef } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentProjects } from "./projects";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "./query";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";
import { workflowsEnvironment } from "./workflows";

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
 * Changes when a thread in the project starts, stops, or starts waiting on you. Stage moves
 * happen at those points, so a board that is on screen re-reads then instead of polling.
 */
const boardSignalAtom = Atom.family((key: string) =>
  Atom.make((get) => get(boardSignalsAtom).get(key) ?? "").pipe(
    Atom.withLabel(`feature-board-signal:${key}`),
  ),
);

export const featuresEnvironment = createFeatureAtoms(connectionAtomRuntime, {
  workflowFeature: workflowsEnvironment.feature,
  boardRefreshTrigger: ({ environmentId, input }) =>
    boardSignalAtom(boardKey({ environmentId, projectId: input.projectId })),
});

const boardAtom = (target: FeatureBoardTarget) =>
  featuresEnvironment.board({
    environmentId: target.environmentId,
    input: { projectId: target.projectId },
  });

/** Projects on environments whose server runs workflows. */
export const crewProjectsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  return get(environmentProjects.projectsAtom).filter(
    (project) => configs.get(project.environmentId)?.environment.capabilities.workflows === true,
  );
}).pipe(Atom.withLabel("crew-projects"));

/** Workflow projects the board can show: the active bot's, or every one without a switcher. */
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

/** How often a focused board re-reads. */
const FOCUSED_BOARD_REFRESH_MS = 30_000;

/**
 * The server-built board cards of every target, merged. Each project loads and fails on its
 * own. Boards re-read when the screen gains focus and every 30 seconds while it keeps it: a
 * decision made on another device (a pause, or an approval that starts no run yet) moves no
 * thread here, so the thread signal alone would miss it.
 */
export function useFeatureBoard(targets: ReadonlyArray<FeatureBoardTarget>) {
  const registry = useContext(RegistryContext);
  const key = JSON.stringify(targets.map(boardKey));
  // Callers rebuild `targets` every render; the key is what identifies the set.
  const stableTargets = useMemo(() => targets, [key]);
  const resultsAtom = useMemo(
    () =>
      Atom.make((get) =>
        stableTargets.map((target) => ({ target, result: get(boardAtom(target)) })),
      ).pipe(Atom.withLabel(`feature-board:${key}`)),
    [key, stableTargets],
  );
  const results = useAtomValue(resultsAtom);

  const refresh = useCallback(() => {
    for (const target of stableTargets) registry.refresh(boardAtom(target));
  }, [registry, stableTargets]);
  useFocusEffect(
    useCallback(() => {
      if (stableTargets.length === 0) return undefined;
      refresh();
      const timer = setInterval(refresh, FOCUSED_BOARD_REFRESH_MS);
      return () => clearInterval(timer);
    }, [refresh, stableTargets.length]),
  );

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

/** An open stage thread with its feature's workflow snapshot. */
export interface CrewThreadStage {
  readonly threadId: ThreadId;
  readonly summary: CrewStageSummary;
  readonly snapshot: WorkflowFeatureSnapshot;
  /** The stage thread's title, which names the feature. */
  readonly title: string;
}

/**
 * Loads a stage thread's feature only while the thread is open, and reloads it when the
 * shell's `crew` summary or run status says something moved.
 */
export function useCrewThreadStage(thread: EnvironmentThreadShell): CrewThreadStage | null {
  const crew = thread.crew ?? null;
  const query = useEnvironmentQuery(
    crew
      ? workflowsEnvironment.feature({
          environmentId: thread.environmentId,
          input: { projectId: thread.projectId, featureId: crew.featureId },
        })
      : null,
  );
  const changeKey = crewStageRefreshKey(crew, thread.latestRun?.status);
  const lastKey = useRef(changeKey);
  const { refresh } = query;
  useEffect(() => {
    if (changeKey === lastKey.current) return;
    lastKey.current = changeKey;
    if (changeKey !== null) refresh();
  }, [changeKey, refresh]);

  const snapshot = query.data;
  return useMemo(
    () =>
      crew && snapshot && snapshot.featureId === crew.featureId
        ? { threadId: thread.id, summary: crew, snapshot, title: thread.title }
        : null,
    [crew, snapshot, thread.id, thread.title],
  );
}
