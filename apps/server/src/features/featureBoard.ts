import type { FeatureBoardCard, FeatureCardState, WorkflowStepEvent } from "@t3tools/contracts";

import type { FeatureWorkflowCopy } from "../workflows/WorkflowStore.ts";
import type { FeatureRecord } from "./FeatureService.ts";
import { featureCardState, featureStage, type WorkflowState } from "../workflows/WorkflowState.ts";

const DETAIL_MAX = 280;

/** The event kinds whose detail explains a state, newest first wins. */
const DETAIL_EVENTS: Partial<Record<FeatureCardState, ReadonlyArray<WorkflowStepEvent["kind"]>>> = {
  input: ["question"],
  failed: ["failed"],
  approval: ["completed"],
  "your-call": ["completed"],
};

const trimDetail = (text: string | null | undefined) => {
  const value = text?.trim();
  if (!value) return null;
  return value.length > DETAIL_MAX ? `${value.slice(0, DETAIL_MAX - 1)}…` : value;
};

/**
 * Builds a board card from a feature's projected workflow. `threadId` is the thread of the
 * card's stage run, looked up by the caller.
 */
export const featureBoardCard = (input: {
  readonly feature: FeatureRecord;
  readonly copy: FeatureWorkflowCopy;
  readonly state: WorkflowState;
  readonly events: ReadonlyArray<WorkflowStepEvent>;
  readonly execution: {
    readonly queuedAt: string | null;
    readonly lastError: string | null;
  } | null;
  readonly latestRevision: number | null;
  readonly threadId: FeatureBoardCard["threadId"];
}): FeatureBoardCard => {
  const { feature, copy, state, events, execution } = input;
  const queuedAt = execution?.queuedAt ?? null;
  const cardState = featureCardState(state, queuedAt !== null);
  const position = featureStage(copy.definition, state);
  const step = position ? copy.definition.steps[position.stepId] : undefined;
  const stepState = position ? state.steps.get(position.stepId) : undefined;
  const detailKinds = DETAIL_EVENTS[cardState];
  const detailEvent = detailKinds
    ? events.findLast(
        (event) => event.stepId === position?.stepId && detailKinds.includes(event.kind),
      )
    : undefined;
  const detail =
    trimDetail(detailEvent?.detail) ??
    (cardState === "failed" ? trimDetail(execution?.lastError) : null);
  return {
    featureId: feature.id,
    projectId: feature.projectId,
    title: feature.title,
    workflow: {
      id: copy.definition.id,
      name: copy.definition.name,
      revision: copy.definition.revision,
      latestRevision: input.latestRevision,
    },
    state: cardState,
    started: execution !== null || state.executionCount > 0,
    stateSince:
      cardState === "queued" && queuedAt !== null
        ? queuedAt
        : (events.at(-1)?.occurredAt ?? copy.createdAt),
    stage:
      position && step?.type === "task"
        ? {
            ...position,
            role: step.bot,
            attempt: stepState?.attempt ?? 0,
            gate: step.gate === true,
          }
        : null,
    threadId: input.threadId,
    detail,
    yourCall: state.yourCall,
    queuedAt,
  };
};

/** The bot run whose thread a card opens: the stage's own run, else the latest run. */
export const featureBoardRunId = (
  state: WorkflowState,
  events: ReadonlyArray<WorkflowStepEvent>,
  stepId: string | null,
) =>
  (stepId ? state.steps.get(stepId)?.botRunId : null) ??
  events.findLast((event) => event.botRunId !== null)?.botRunId ??
  null;
