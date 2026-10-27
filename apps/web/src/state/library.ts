import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentLibrary } from "@t3tools/client-runtime/state/library";
import type { EnvironmentId, RoleConfig, WorkflowDefinition } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironmentFilter } from "./botRail";
import { environmentSummaries } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { rolesEnvironment } from "./roles";
import { environmentServerConfigsAtom } from "./server";
import { workflowsEnvironment } from "./workflows";

export interface EnvironmentLibraryState {
  readonly environmentId: EnvironmentId;
  /** Null until the environment's list loads. */
  readonly workflows: ReadonlyArray<WorkflowDefinition> | null;
  readonly roles: ReadonlyArray<RoleConfig> | null;
  readonly error: string | null;
}

/** Workflows and roles on every connected environment that runs workflows, live. */
const libraryStateAtom = Atom.make((get): ReadonlyArray<EnvironmentLibraryState> => {
  const configs = get(environmentServerConfigsAtom);
  return get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const capabilities = configs.get(environmentId)?.environment.capabilities;
    if (capabilities?.workflows !== true || capabilities.crew !== true) return [];
    const workflows = get(workflowsEnvironment.definitions({ environmentId, input: {} }));
    const roles = get(rolesEnvironment.roles({ environmentId, input: {} }));
    const failure =
      workflows._tag === "Failure" ? workflows : roles._tag === "Failure" ? roles : null;
    return [
      {
        environmentId,
        workflows: Option.getOrNull(AsyncResult.value(workflows)),
        roles: Option.getOrNull(AsyncResult.value(roles)),
        error: failure === null ? null : formatEnvironmentQueryError(failure.cause),
      },
    ];
  });
}).pipe(Atom.withLabel("web-library:environments"));

/** Every connected environment's library, whatever the rail's filter shows. */
export function useLibraries(): ReadonlyArray<EnvironmentLibraryState> {
  return useAtomValue(libraryStateAtom);
}

/** Each environment's library, on the environments the rail's filter shows. */
export function useLibraryByEnvironment(): ReadonlyArray<EnvironmentLibraryState> {
  const states = useLibraries();
  const environmentFilter = useEnvironmentFilter();
  return environmentFilter === null
    ? states
    : states.filter((state) => environmentFilter.has(state.environmentId));
}

export const loadedLibraries = (
  states: ReadonlyArray<EnvironmentLibraryState>,
): EnvironmentLibrary[] =>
  states.flatMap(({ environmentId, workflows, roles }) =>
    workflows === null || roles === null ? [] : [{ environmentId, workflows, roles }],
  );
