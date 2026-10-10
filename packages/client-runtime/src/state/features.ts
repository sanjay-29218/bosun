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
  const refreshTarget = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId; readonly featureId: string };
    },
    registry: AtomRegistry.AtomRegistry,
  ) => refresh(target.environmentId, target.input.projectId, target.input.featureId, registry);
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
      onSuccess: refreshTarget,
    }),
    // Feature actions. Each returns the feature's workflow snapshot.
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:start",
      tag: WS_METHODS.featuresStart,
      onSuccess: refreshTarget,
    }),
    reopen: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:reopen",
      tag: WS_METHODS.featuresReopen,
      onSuccess: refreshTarget,
    }),
    approve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:approve",
      tag: WS_METHODS.workflowsApprove,
      onSuccess: refreshTarget,
    }),
    requestChanges: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:request-changes",
      tag: WS_METHODS.workflowsRequestChanges,
      onSuccess: refreshTarget,
    }),
    takeOver: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:take-over",
      tag: WS_METHODS.workflowsTakeOver,
      onSuccess: refreshTarget,
    }),
    markDone: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:mark-done",
      tag: WS_METHODS.workflowsMarkDone,
      onSuccess: refreshTarget,
    }),
    sendBack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:send-back",
      tag: WS_METHODS.workflowsSendBack,
      onSuccess: refreshTarget,
    }),
    skip: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:skip",
      tag: WS_METHODS.workflowsSkip,
      onSuccess: refreshTarget,
    }),
    acceptAsIs: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:accept-as-is",
      tag: WS_METHODS.workflowsAcceptAsIs,
      onSuccess: refreshTarget,
    }),
    oneMoreRound: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:one-more-round",
      tag: WS_METHODS.workflowsOneMoreRound,
      onSuccess: refreshTarget,
    }),
    startNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:start-now",
      tag: WS_METHODS.workflowsStartNow,
      onSuccess: refreshTarget,
    }),
  };
}
