import { WS_METHODS, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/** Workflow definitions are a global library; feature state is read from the environment that owns the project. */
export function createWorkflowAtoms<R, ER>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>) {
  const definitions = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workflows:definitions",
    tag: WS_METHODS.workflowsList,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  const feature = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workflows:feature",
    tag: WS_METHODS.workflowsGetFeature,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
  });
  /** The handoff a stage thread started from; null for threads outside a workflow. */
  const stageHandoff = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:workflows:stage-handoff",
    tag: WS_METHODS.workflowsGetStageHandoff,
    staleTimeMs: 60_000,
    idleTtlMs: 60_000,
  });
  const refreshDefinitions = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(definitions({ environmentId: target.environmentId, input: {} })),
    );
  const refreshFeature = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId; readonly featureId: string };
    },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.refresh(feature(target)));
  return {
    definitions,
    feature,
    stageHandoff,
    ensureStarter: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:ensure-starter",
      tag: WS_METHODS.workflowsEnsureStarter,
      onSuccess: refreshDefinitions,
    }),
    validate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:validate",
      tag: WS_METHODS.workflowsValidate,
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:create",
      tag: WS_METHODS.workflowsCreate,
      onSuccess: refreshDefinitions,
    }),
    revise: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:revise",
      tag: WS_METHODS.workflowsRevise,
      onSuccess: refreshDefinitions,
    }),
    answer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:answer",
      tag: WS_METHODS.workflowsAnswer,
      onSuccess: (target, registry) =>
        refreshFeature(
          {
            environmentId: target.environmentId,
            input: { projectId: target.input.projectId, featureId: target.input.featureId },
          },
          registry,
        ),
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:retry",
      tag: WS_METHODS.workflowsRetry,
      onSuccess: (target, registry) =>
        refreshFeature(
          {
            environmentId: target.environmentId,
            input: { projectId: target.input.projectId, featureId: target.input.featureId },
          },
          registry,
        ),
    }),
    pause: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:pause",
      tag: WS_METHODS.workflowsPause,
      onSuccess: (target, registry) =>
        refreshFeature(
          {
            environmentId: target.environmentId,
            input: { projectId: target.input.projectId, featureId: target.input.featureId },
          },
          registry,
        ),
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:resume",
      tag: WS_METHODS.workflowsResume,
      onSuccess: (target, registry) =>
        refreshFeature(
          {
            environmentId: target.environmentId,
            input: { projectId: target.input.projectId, featureId: target.input.featureId },
          },
          registry,
        ),
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:cancel",
      tag: WS_METHODS.workflowsCancel,
      onSuccess: (target, registry) =>
        refreshFeature(
          {
            environmentId: target.environmentId,
            input: { projectId: target.input.projectId, featureId: target.input.featureId },
          },
          registry,
        ),
    }),
  };
}
