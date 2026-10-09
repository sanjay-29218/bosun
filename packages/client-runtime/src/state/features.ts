import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry } from "effect/reactivity";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createFeatureAtoms<R, ER>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:list",
    tag: WS_METHODS.featuresList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:detail",
    tag: WS_METHODS.featuresGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const refresh = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    featureId: string,
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId, input: { projectId } }));
      registry.refresh(detail({ environmentId, input: { projectId, featureId } }));
    });
  return {
    list,
    detail,
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:create",
      tag: WS_METHODS.featuresCreate,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.id, registry),
    }),
    setStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:set-status",
      tag: WS_METHODS.featuresSetStatus,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.featureId, registry),
    }),
  };
}
