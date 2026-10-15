import {
  WS_METHODS,
  WorkflowHandoffOutcome,
  type BotHandoff,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/unstable/reactivity";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const decodeOutcome = Schema.decodeUnknownOption(Schema.fromJsonString(WorkflowHandoffOutcome));

/** Display a workflow result as its outcome and evidence while preserving other bot responses. */
export function featureHandoffText(handoff: BotHandoff) {
  if (handoff.questionText !== null) return handoff.questionText;
  if (handoff.responseText !== null) {
    const outcome = decodeOutcome(handoff.responseText);
    return Option.isSome(outcome)
      ? `${outcome.value.outcome} · ${outcome.value.summary}`
      : handoff.responseText;
  }
  return handoff.lastError ?? handoff.taskText;
}

export function createFeatureAtoms<R, ER>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>) {
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:list",
    tag: WS_METHODS.featuresList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 10_000,
  });
  const inspection = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:inspection",
    tag: WS_METHODS.featuresInspect,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 10_000,
  });
  const detail = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:detail",
    tag: WS_METHODS.featuresGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 10_000,
  });
  const launchState = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:launch",
    tag: WS_METHODS.featuresGetLaunch,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshIntervalMs: 10_000,
  });
  const refresh = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    featureId: string,
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(list({ environmentId, input: { projectId } }));
      registry.refresh(inspection({ environmentId, input: { projectId, featureId } }));
      registry.refresh(detail({ environmentId, input: { projectId, featureId } }));
      registry.refresh(launchState({ environmentId, input: { projectId, featureId } }));
    });
  return {
    inspection,
    prepareCheckout: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:prepare",
      tag: WS_METHODS.featuresPrepareCheckout,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.featureId, registry),
    }),
    recordArtifact: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:artifact",
      tag: WS_METHODS.featuresRecordArtifact,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.featureId, registry),
    }),
    list,
    detail,
    launchState,
    launch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:launch",
      tag: WS_METHODS.featuresLaunch,
      onSuccess: (target, registry) =>
        refresh(target.environmentId, target.input.projectId, target.input.featureId, registry),
    }),
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
