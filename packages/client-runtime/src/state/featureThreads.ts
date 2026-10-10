import {
  WS_METHODS,
  workflowForwardOutcome,
  workflowForwardStages,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Making a thread a feature, and detaching it again. `link` says whether a thread is a
 * feature's current stage, which decides between "Make it a feature…" and "Detach".
 */
export function createFeatureThreadAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, ER>,
) {
  const link = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:features:thread-link",
    tag: WS_METHODS.featuresThreadLink,
    staleTimeMs: 2_000,
    idleTtlMs: 60_000,
  });
  return {
    link,
    attach: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:attach-thread",
      tag: WS_METHODS.featuresAttachThread,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            link({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId, threadId: target.input.threadId },
            }),
          ),
        ),
    }),
    detach: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:features:detach-thread",
      tag: WS_METHODS.featuresDetachThread,
      onSuccess: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            link({
              environmentId: target.environmentId,
              input: { projectId: target.input.projectId, threadId: target.input.threadId },
            }),
          ),
        ),
    }),
  };
}

/** A workflow bot's display name and model, keyed by template or project bot ID. */
export interface FeatureDraftRole {
  readonly name: string;
  readonly model: string;
}

export interface FeatureDraftStage {
  readonly stepId: string;
  readonly label: string;
  /** "stage 2 of 4", counted over the stages a thread can be attached at. */
  readonly index: number;
  readonly total: number;
}

export interface FeatureDraft {
  readonly stages: ReadonlyArray<FeatureDraftStage>;
  readonly stage: FeatureDraftStage | null;
  /** The stage the result is handed to, or null when this is the last one. */
  readonly next: {
    readonly label: string;
    readonly role: FeatureDraftRole | null;
    /** The chosen stage waits for approval before handing on. */
    readonly gated: boolean;
  } | null;
}

/** "qa_review" → "Qa review": step IDs are the only stage names a workflow has. */
export const stageLabel = (stepId: string) => {
  const words = stepId.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** What the Make it a feature dialog shows for `stageId`, from the workflow alone. */
export function makeFeatureDraft(
  definition: WorkflowDefinition,
  stageId: string | null,
  roles: ReadonlyMap<string, FeatureDraftRole> = new Map(),
): FeatureDraft {
  const ids = workflowForwardStages(definition);
  const stages = ids.map((stepId, position) => ({
    stepId,
    label: stageLabel(stepId),
    index: position + 1,
    total: ids.length,
  }));
  const stage = stages.find((candidate) => candidate.stepId === stageId) ?? null;
  const step = stage ? definition.steps[stage.stepId] : undefined;
  const outcome = stage ? workflowForwardOutcome(definition, stage.stepId) : null;
  const nextId = step?.type === "task" && outcome !== null ? step.next[outcome] : undefined;
  const nextStep = nextId === undefined ? undefined : definition.steps[nextId];
  if (step?.type !== "task" || nextStep?.type !== "task") return { stages, stage, next: null };
  const bot = definition.bots[nextStep.bot];
  return {
    stages,
    stage,
    next: {
      label: stageLabel(nextId!),
      role: bot ? (roles.get(bot.template.id) ?? null) : null,
      gated: step.gate === true,
    },
  };
}
