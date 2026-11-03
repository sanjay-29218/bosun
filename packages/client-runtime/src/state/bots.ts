import { WS_METHODS, type CrewRevision, type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Top-level bots of one environment. The list is fetched, not streamed: bots change rarely,
 * and a project moving between bots already arrives as a project shell update.
 */
export function createBotsAtoms<R, ER>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bots:list",
    tag: WS_METHODS.botsList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const refreshList = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => registry.refresh(list({ environmentId: target.environmentId, input: {} })));
  return {
    list,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:create",
      tag: WS_METHODS.botsCreate,
      onSuccess: refreshList,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:update",
      tag: WS_METHODS.botsUpdate,
      onSuccess: refreshList,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:delete",
      tag: WS_METHODS.botsDelete,
      onSuccess: refreshList,
    }),
    reorder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:reorder",
      tag: WS_METHODS.botsReorder,
      onSuccess: refreshList,
    }),
    moveProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:move-project",
      tag: WS_METHODS.botsMoveProject,
    }),
    openHeadquarters: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:open-headquarters",
      tag: WS_METHODS.botsOpenHeadquarters,
    }),
    startNewSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:start-new-session",
      tag: WS_METHODS.botsStartNewSession,
    }),
  };
}

const CREW_SCOPES = ["bots", "library", "features"] as const;

/**
 * Which lists to re-read when an environment's crew counts move (`crewUpdated`): the server
 * counts every change to bots, the Library and features, whoever made it.
 */
function changedCrewScopes(
  previous: CrewRevision | undefined,
  next: CrewRevision | undefined,
): ReadonlyArray<keyof CrewRevision> {
  if (previous === undefined || next === undefined) return [];
  return CREW_SCOPES.filter((scope) => previous[scope] !== next[scope]);
}

/**
 * Re-reads an environment's lists when its crew counts move, with `refresh` saying how per list.
 * Returns the unsubscribe.
 */
export function subscribeCrewListRefresh(
  registry: AtomRegistry.AtomRegistry,
  configsAtom: Atom.Atom<
    ReadonlyMap<EnvironmentId, { readonly crewRevision?: CrewRevision | undefined }>
  >,
  refresh: Partial<Record<keyof CrewRevision, (environmentId: EnvironmentId) => void>>,
): () => void {
  let previous = new Map<EnvironmentId, CrewRevision | undefined>();
  return registry.subscribe(
    configsAtom,
    (configs) => {
      const next = new Map<EnvironmentId, CrewRevision | undefined>();
      for (const [environmentId, config] of configs) {
        next.set(environmentId, config.crewRevision);
        for (const scope of changedCrewScopes(previous.get(environmentId), config.crewRevision)) {
          refresh[scope]?.(environmentId);
        }
      }
      previous = next;
    },
    { immediate: true },
  );
}
