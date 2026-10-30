import { useAtomValue } from "@effect/atom-react";
import {
  groupAutomationsByBot,
  hasUnseenAutomationFailure,
  runningAutomationKeys,
  type AutomationGroup,
  type EnvironmentScheduledTasks,
} from "@t3tools/client-runtime/state/automations";
import type { EnvironmentId, ScheduledTask } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useUiStateStore } from "../uiStateStore";
import { logicalBotsAtom, useEnvironmentFilter } from "./botRail";
import { environmentSummaries } from "./presentation";
import { environmentProjects } from "./projects";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";
import { environmentThreadShells } from "./threads";

export interface EnvironmentScheduledTasksState {
  readonly environmentId: EnvironmentId;
  /** Null until the environment's list loads. */
  readonly tasks: ReadonlyArray<ScheduledTask> | null;
  readonly error: string | null;
}

/** Every connected environment's scheduled tasks, live. */
const scheduledTasksStateAtom = Atom.make((get): ReadonlyArray<EnvironmentScheduledTasksState> =>
  get(environmentSummaries.connectedEnvironmentIdsAtom).map((environmentId) => {
    const result = get(serverEnvironment.scheduledTasksLive({ environmentId, input: {} }));
    return {
      environmentId,
      tasks: Option.getOrNull(AsyncResult.value(result))?.tasks ?? null,
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    };
  }),
).pipe(Atom.withLabel("web-automations:tasks"));

const loadedTasks = (
  states: ReadonlyArray<EnvironmentScheduledTasksState>,
): EnvironmentScheduledTasks[] =>
  states.flatMap(({ environmentId, tasks }) => (tasks === null ? [] : [{ environmentId, tasks }]));

/** Keys of the tasks running now. Shells stream while agents work, so the set is kept until it changes. */
const runningAutomationKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const next = runningAutomationKeys(
    loadedTasks(get(scheduledTasksStateAtom)),
    get(environmentThreadShells.threadShellsAtom),
  );
  const previous = Option.getOrNull(get.self<ReadonlySet<string>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every((key) => previous.has(key))
    ? previous
    : next;
}).pipe(Atom.withLabel("web-automations:running"));

/** One connected environment's tasks, or null until they load. */
export function useEnvironmentScheduledTasks(
  environmentId: EnvironmentId,
): ReadonlyArray<ScheduledTask> | null {
  return (
    useAtomValue(scheduledTasksStateAtom).find((state) => state.environmentId === environmentId)
      ?.tasks ?? null
  );
}

/** Each environment's tasks, on the environments the rail's filter shows. */
export function useScheduledTasksByEnvironment(): ReadonlyArray<EnvironmentScheduledTasksState> {
  const states = useAtomValue(scheduledTasksStateAtom);
  const environmentFilter = useEnvironmentFilter();
  return environmentFilter === null
    ? states
    : states.filter((state) => environmentFilter.has(state.environmentId));
}

/** The shown tasks grouped under their bots, in rail order. */
export function useAutomationGroups(): ReadonlyArray<AutomationGroup> {
  const states = useScheduledTasksByEnvironment();
  const bots = useAtomValue(logicalBotsAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  return groupAutomationsByBot({ environments: loadedTasks(states), projects, bots });
}

/** A connected environment this client may create tasks on, preferring `preferred`. */
const scheduledTaskCreationEnvironmentAtom = Atom.family((preferred: string) =>
  Atom.make((get): EnvironmentId | null => {
    const permitted = get(environmentSummaries.connectedEnvironmentIdsAtom).filter(
      (environmentId) => get(serverEnvironment.upsertScheduledTask.permissionAtom(environmentId)),
    );
    return permitted.find((environmentId) => environmentId === preferred) ?? permitted[0] ?? null;
  }).pipe(Atom.withLabel(`web-automations:creation-environment:${preferred}`)),
);

export function useScheduledTaskCreationEnvironmentId(
  preferred: EnvironmentId | null,
): EnvironmentId | null {
  return useAtomValue(scheduledTaskCreationEnvironmentAtom(preferred ?? ""));
}

export function useRunningAutomationKeys(): ReadonlySet<string> {
  return useAtomValue(runningAutomationKeysAtom);
}

/** The Automations rail icon's red dot: a shown task's last run failed and nobody opened it. */
export function useHasUnseenAutomationFailure(): boolean {
  const states = useScheduledTasksByEnvironment();
  const seen = useUiStateStore((store) => store.seenAutomationFailureAtByKey);
  return hasUnseenAutomationFailure(loadedTasks(states), seen);
}
