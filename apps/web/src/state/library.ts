import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentLibrary } from "@t3tools/client-runtime/state/library";
import type { EnvironmentId, RoleConfig, WorkflowConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { useEnvironmentFilter } from "./botRail";
import { environmentSummaries } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { rolesEnvironment } from "./roles";
import { environmentServerConfigsAtom } from "./server";

export interface EnvironmentLibraryState {
  readonly environmentId: EnvironmentId;
  /** Null until the environment's lists load. */
  readonly roles: ReadonlyArray<RoleConfig> | null;
  readonly workflows: ReadonlyArray<WorkflowConfig> | null;
  readonly error: string | null;
}

/** Roles and workflows on every connected environment that runs feature crews, live. */
const libraryStateAtom = Atom.make((get): ReadonlyArray<EnvironmentLibraryState> => {
  const configs = get(environmentServerConfigsAtom);
  return get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const capabilities = configs.get(environmentId)?.environment.capabilities;
    if (capabilities?.workflows !== true || capabilities.crew !== true) return [];
    const roles = get(rolesEnvironment.roles({ environmentId, input: {} }));
    const workflows = get(rolesEnvironment.workflows({ environmentId, input: {} }));
    const failure =
      roles._tag === "Failure" ? roles : workflows._tag === "Failure" ? workflows : null;
    return [
      {
        environmentId,
        roles: Option.getOrNull(AsyncResult.value(roles)),
        workflows: Option.getOrNull(AsyncResult.value(workflows)),
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
  states.flatMap(({ environmentId, roles, workflows }) =>
    roles === null || workflows === null ? [] : [{ environmentId, roles, workflows }],
  );
