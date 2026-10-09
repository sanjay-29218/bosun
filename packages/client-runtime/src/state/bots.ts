import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Project-scoped reads and actions always execute on the environment that owns the project. */
export function createBotsAtoms<R, ER>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>) {
  const snapshot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bots:snapshot",
    tag: WS_METHODS.botsSnapshot,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 10_000,
  });
  const configuration = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:bots:configuration",
    tag: WS_METHODS.botsConfiguration,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
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
    snapshot,
    configuration,
    initialize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:initialize",
      tag: WS_METHODS.botsInitialize,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    createTemplate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:create-template",
      tag: WS_METHODS.botsCreateTemplate,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    updateTemplate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:update-template",
      tag: WS_METHODS.botsUpdateTemplate,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    instantiate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:instantiate",
      tag: WS_METHODS.botsInstantiate,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    setHierarchy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:set-hierarchy",
      tag: WS_METHODS.botsSetHierarchy,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    setDelegation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:set-delegation",
      tag: WS_METHODS.botsSetDelegation,
      onSuccess: (target, registry) =>
        refreshConfiguration(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:start",
      tag: WS_METHODS.botsStart,
      onSuccess: ({ environmentId, input }, registry) =>
        refresh({ environmentId, input: { projectId: input.projectId } }, registry),
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:answer",
      tag: WS_METHODS.botsAnswer,
      onSuccess: (target, registry) =>
        refresh(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:cancel",
      tag: WS_METHODS.botsCancel,
      onSuccess: (target, registry) =>
        refresh(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:retry",
      tag: WS_METHODS.botsRetry,
      onSuccess: (target, registry) =>
        refresh(
          { environmentId: target.environmentId, input: { projectId: target.input.projectId } },
          registry,
        ),
    }),
  };
}
