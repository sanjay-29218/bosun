import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Roles are global to an environment; crew reads and actions execute on the environment that
 * owns the project.
 */
export function createRoleAtoms<R, ER>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>) {
  const roles = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:roles:list",
    tag: WS_METHODS.rolesList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const snapshot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:crew:snapshot",
    tag: WS_METHODS.crewSnapshot,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 10_000,
  });
  const configuration = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:crew:configuration",
    tag: WS_METHODS.crewConfiguration,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const refreshRoles = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => registry.refresh(roles({ environmentId: target.environmentId, input: {} })));
  const refresh = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(snapshot(target)));
  const refreshConfiguration = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(configuration(target));
      registry.refresh(snapshot(target));
    });
  return {
    roles,
    snapshot,
    configuration,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:roles:create",
      tag: WS_METHODS.rolesCreate,
      onSuccess: refreshRoles,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:roles:update",
      tag: WS_METHODS.rolesUpdate,
      onSuccess: refreshRoles,
    }),
    /** Creates the missing default roles and the Captain. */
    initialize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:initialize",
      tag: WS_METHODS.crewInitialize,
      onSuccess: refreshRoles,
    }),
    instantiate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:instantiate",
      tag: WS_METHODS.crewInstantiate,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    setHierarchy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:set-hierarchy",
      tag: WS_METHODS.crewSetHierarchy,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    setDelegation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:set-delegation",
      tag: WS_METHODS.crewSetDelegation,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:start",
      tag: WS_METHODS.crewStart,
      onSuccess: ({ environmentId, input }, registry) =>
        refresh({ environmentId, input: { projectId: input.projectId } }, registry),
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:answer",
      tag: WS_METHODS.crewAnswer,
      onSuccess: (target, registry) =>
        refresh(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:cancel",
      tag: WS_METHODS.crewCancel,
      onSuccess: (target, registry) =>
        refresh(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:crew:retry",
      tag: WS_METHODS.crewRetry,
      onSuccess: (target, registry) =>
        refresh(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
  };
}
