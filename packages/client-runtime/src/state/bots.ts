import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
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
