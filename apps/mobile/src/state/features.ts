import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { isBotThreadId } from "@t3tools/client-runtime/bot-message-origin";
import {
  crewStageThreads,
  type CrewFeature,
  type CrewStageThread,
} from "@t3tools/client-runtime/state/crew";
import { createFeatureAtoms } from "@t3tools/client-runtime/state/features";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useContext } from "react";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { scopedThreadKey } from "../lib/scopedEntities";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

const boardKey = (environmentId: EnvironmentId, projectId: ProjectId) =>
  JSON.stringify([environmentId, projectId]);

/**
 * Changes when a bot thread in the project starts or finishes a run, or a new one appears.
 * Stage moves happen at those points, so the board re-reads then instead of polling.
 */
const boardSignalAtom = Atom.family((key: string) => {
  const [environmentId, projectId] = JSON.parse(key) as [string, string];
  return Atom.make((get) =>
    get(environmentThreadShells.environmentThreadsAtom(EnvironmentId.make(environmentId)))
      .filter((thread) => thread.projectId === projectId && isBotThreadId(thread.id))
      .map((thread) => `${thread.id}:${thread.status}:${thread.latestRunId ?? ""}`)
      .join("|"),
  ).pipe(Atom.withLabel(`crew-board-signal:${key}`));
});

export const featuresEnvironment = createFeatureAtoms(connectionAtomRuntime, {
  boardRefreshTrigger: ({ environmentId, input }) =>
    boardSignalAtom(boardKey(environmentId, input.projectId)),
});

export function crewBoardAtom(project: { environmentId: EnvironmentId; projectId: ProjectId }) {
  return featuresEnvironment.board({
    environmentId: project.environmentId,
    input: { projectId: project.projectId },
  });
}

/** Projects on environments whose server runs Crew mode. */
export const crewProjectsAtom = Atom.make((get) => {
  const configs = get(environmentServerConfigsAtom);
  return get(environmentProjects.projectsAtom).filter(
    (project) => configs.get(project.environmentId)?.environment.capabilities.workflows === true,
  );
}).pipe(Atom.withLabel("crew-projects"));

export interface CrewBoardEntry {
  readonly project: EnvironmentProject;
  readonly features: ReadonlyArray<CrewFeature>;
}

const EMPTY_FEATURES: ReadonlyArray<CrewFeature> = [];

/** Every Crew project's loaded board. A board that is still loading or failed counts as empty. */
export const crewBoardsAtom = Atom.make((get): ReadonlyArray<CrewBoardEntry> =>
  get(crewProjectsAtom).map((project) => ({
    project,
    features: Option.getOrElse(
      AsyncResult.value(
        get(crewBoardAtom({ environmentId: project.environmentId, projectId: project.id })),
      ),
      () => EMPTY_FEATURES,
    ),
  })),
).pipe(Atom.withLabel("crew-boards"));

export interface CrewThreadStage extends CrewStageThread {
  readonly environmentId: EnvironmentId;
}

/** Stage threads by `environmentId:threadId`. */
export const crewStageIndexAtom = Atom.make((get) => {
  const index = new Map<string, CrewThreadStage>();
  for (const board of get(crewBoardsAtom)) {
    for (const feature of board.features) {
      for (const stage of crewStageThreads(feature)) {
        index.set(scopedThreadKey(board.project.environmentId, stage.threadId), {
          ...stage,
          environmentId: board.project.environmentId,
        });
      }
    }
  }
  return index;
}).pipe(Atom.withLabel("crew-stage-index"));

let previousHiddenThreadKeys: ReadonlySet<string> = new Set();
/** Earlier stage threads of a feature: lists show one row per feature, its current stage. */
export const crewHiddenThreadKeysAtom = Atom.make((get) => {
  const hidden = new Set<string>();
  for (const [key, stage] of get(crewStageIndexAtom)) {
    if (!stage.summary.current) hidden.add(key);
  }
  // Keep the previous set when nothing moved, so thread lists don't rebuild on every refresh.
  const unchanged =
    hidden.size === previousHiddenThreadKeys.size &&
    [...hidden].every((key) => previousHiddenThreadKeys.has(key));
  if (!unchanged) previousHiddenThreadKeys = hidden;
  return previousHiddenThreadKeys;
}).pipe(Atom.withLabel("crew-hidden-thread-keys"));

const crewThreadStageAtom = Atom.family((key: string) =>
  Atom.make((get) => get(crewStageIndexAtom).get(key) ?? null).pipe(
    Atom.withLabel(`crew-thread-stage:${key}`),
  ),
);

export function useCrewThreadStage(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): CrewThreadStage | null {
  return useAtomValue(crewThreadStageAtom(scopedThreadKey(environmentId, threadId)));
}

export function useCrewHiddenThreadKeys(): ReadonlySet<string> {
  return useAtomValue(crewHiddenThreadKeysAtom);
}

export function useCrewBoards(): ReadonlyArray<CrewBoardEntry> {
  return useAtomValue(crewBoardsAtom);
}

export function useCrewProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(crewProjectsAtom);
}

/** How often a focused Crew view re-reads its boards. */
const FOCUSED_BOARD_REFRESH_MS = 30_000;

/**
 * Re-reads boards when the screen gains focus and every 30 seconds while it keeps it. A
 * decision made on another device (a pause, or an approval that starts no new run yet) moves
 * no bot thread here, so the board's thread signal alone would miss it.
 */
export function useRefreshCrewBoardsWhileFocused(
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>,
) {
  const registry = useContext(RegistryContext);
  const key = JSON.stringify(projects.map((project) => [project.environmentId, project.projectId]));
  useFocusEffect(
    useCallback(() => {
      const targets = (JSON.parse(key) as Array<[string, string]>).map(
        ([environmentId, projectId]) => ({
          environmentId: environmentId as EnvironmentId,
          projectId: projectId as ProjectId,
        }),
      );
      if (targets.length === 0) return undefined;
      const refresh = () => {
        for (const target of targets) registry.refresh(crewBoardAtom(target));
      };
      refresh();
      const timer = setInterval(refresh, FOCUSED_BOARD_REFRESH_MS);
      return () => clearInterval(timer);
    }, [key, registry]),
  );
}
