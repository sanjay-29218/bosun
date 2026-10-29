import { useAtomValue } from "@effect/atom-react";
import {
  threadBoardSignal,
  type EnvironmentFeatureCard,
} from "@t3tools/client-runtime/state/crew-board";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
import { formatEnvironmentQueryError } from "../../state/query";
import { environmentServerConfigsAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";

export interface FeatureBoardTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const BOARD_REFRESH_MS = 30_000;

const targetKey = (target: FeatureBoardTarget) => `${target.environmentId}:${target.projectId}`;

/** Environments whose server runs workflows, as a stable comma-joined key. */
const workflowEnvironmentsKeyAtom = Atom.make((get) =>
  [...get(environmentServerConfigsAtom)]
    .filter(([, config]) => config.environment.capabilities.workflows === true)
    .map(([environmentId]) => environmentId)
    .toSorted()
    .join(","),
).pipe(Atom.withLabel("web-features:workflow-environments"));

export function useWorkflowEnvironmentIds(): ReadonlySet<string> {
  const key = useAtomValue(workflowEnvironmentsKeyAtom);
  return new Set(key ? key.split(",") : []);
}

/**
 * A per-project string that changes when a thread starts, stops, or starts waiting on you.
 * Stage threads move cards, so a board refetches on that, never on streamed messages.
 */
const threadActivityKeysAtom = Atom.make((get) => {
  const keys = new Map<string, string[]>();
  for (const shell of get(environmentThreadShells.threadShellsAtom)) {
    if (shell.archivedAt !== null) continue;
    const key = `${shell.environmentId}:${shell.projectId}`;
    const parts = keys.get(key) ?? [];
    parts.push(threadBoardSignal(shell));
    keys.set(key, parts);
  }
  return [...keys]
    .map(([key, parts]) => `${key}=${parts.toSorted().join(",")}`)
    .toSorted()
    .join(";");
}).pipe(Atom.withLabel("web-features:thread-activity"));

const boardResultsAtom = (key: string, targets: ReadonlyArray<FeatureBoardTarget>) =>
  Atom.make((get) =>
    targets.map((target) => ({
      target,
      result: get(
        featuresEnvironment.board({
          environmentId: target.environmentId,
          input: { projectId: target.projectId },
        }),
      ),
    })),
  ).pipe(Atom.withLabel(`web-features:board:${key}`));

/** Board cards for every target, merged. Each project loads and fails on its own. */
export function useFeatureBoard(targets: ReadonlyArray<FeatureBoardTarget>) {
  const key = targets.map(targetKey).toSorted().join(",");
  // `targets` is rebuilt by callers on every render; the key is what identifies the set, so
  // the atom is rebuilt only when the key changes.
  const [board, setBoard] = useState(() => ({
    key,
    targets,
    atom: boardResultsAtom(key, targets),
  }));
  if (board.key !== key) setBoard({ key, targets, atom: boardResultsAtom(key, targets) });
  const stableTargets = board.targets;
  const resultsAtom = board.atom;
  const results = useAtomValue(resultsAtom);
  const activity = useAtomValue(threadActivityKeysAtom);

  // Refresh a project's board when its threads change state. The first pass only records.
  const previousActivity = useRef<ReadonlyMap<string, string> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Refetches a project's board from the server when its threads change state.
  useEffect(() => {
    const byProject = new Map(
      activity
        .split(";")
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf("=");
          return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
        }),
    );
    const previous = previousActivity.current;
    previousActivity.current = byProject;
    if (previous === null) return;
    for (const target of stableTargets) {
      const project = targetKey(target);
      if (previous.get(project) !== byProject.get(project)) {
        appAtomRegistry.refresh(
          featuresEnvironment.board({
            environmentId: target.environmentId,
            input: { projectId: target.projectId },
          }),
        );
      }
    }
  }, [activity, stableTargets]);

  // Another client's decision (a cancel, an approval) may change no thread shell here, so an
  // open, visible board also refetches on a slow timer.
  const refresh = () => {
    for (const target of stableTargets)
      appAtomRegistry.refresh(
        featuresEnvironment.board({
          environmentId: target.environmentId,
          input: { projectId: target.projectId },
        }),
      );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls the server while the board is mounted; the interval is cleared on unmount.
  useEffect(() => {
    const handle = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, BOARD_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [refresh]);

  const cards: EnvironmentFeatureCard[] = [];
  const errors: string[] = [];
  let pending = false;
  let loaded = 0;
  for (const { target, result } of results) {
    const value = Option.getOrNull(AsyncResult.value(result));
    if (value !== null) {
      loaded += 1;
      for (const card of value) cards.push({ ...card, environmentId: target.environmentId });
    }
    if (result.waiting && value === null) pending = true;
    if (result._tag === "Failure" && !Cause.hasInterruptsOnly(result.cause))
      errors.push(formatEnvironmentQueryError(result.cause));
  }
  return {
    cards,
    errors,
    /** True until every project has answered at least once. */
    pending,
    loaded: loaded === results.length,
    refresh,
  };
}
