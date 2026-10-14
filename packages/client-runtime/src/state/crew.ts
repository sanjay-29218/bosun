import type {
  ThreadId,
  WorkflowDefinition,
  WorkflowFeatureSnapshot,
  WorkflowStepSnapshot,
} from "@t3tools/contracts";

/**
 * Stage-card logic for an open stage thread. Everything here is pure: it reads one feature's
 * workflow snapshot and derives the card wording and the choices the client offers.
 */

/** Task steps in definition order, which is how the server counts stage positions. */
export function workflowStageIds(definition: WorkflowDefinition): ReadonlyArray<string> {
  return Object.keys(definition.steps).filter((id) => definition.steps[id]?.type === "task");
}

/** Workflows name stages by step id: `change_review` reads "Change review". */
export function humanizeCrewId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? id : words[0]!.toUpperCase() + words.slice(1);
}

export function crewStageRole(definition: WorkflowDefinition, stepId: string): string | null {
  const step = definition.steps[stepId];
  return step?.type === "task" ? humanizeCrewId(step.role) : null;
}

export function crewCurrentStep(snapshot: WorkflowFeatureSnapshot): WorkflowStepSnapshot | null {
  const stepId = snapshot.stage?.stepId ?? null;
  return stepId === null ? null : (snapshot.steps.find((step) => step.id === stepId) ?? null);
}

/**
 * The thread that stands for a feature: its current stage's thread, or, while the next stage
 * has none yet (queued) or the feature is done, the stage thread that started most recently.
 */
export function crewCurrentThreadId(snapshot: WorkflowFeatureSnapshot): ThreadId | null {
  const current = crewCurrentStep(snapshot)?.threadId ?? null;
  if (current !== null) return current;
  const withThread = snapshot.steps.filter((step) => step.threadId !== null);
  const lastStarted = snapshot.recentEvents.findLast(
    (event) => event.kind === "started" && withThread.some((step) => step.id === event.stepId),
  );
  if (lastStarted) return withThread.find((step) => step.id === lastStarted.stepId)!.threadId;
  const stages = workflowStageIds(snapshot.definition);
  return (
    withThread.sort((a, b) => stages.indexOf(b.id) - stages.indexOf(a.id))[0]?.threadId ?? null
  );
}

/** Latest version of a stage's first declared output, such as "design.md v2". */
function stageArtifact(snapshot: WorkflowFeatureSnapshot, stepId: string): string | null {
  const output = snapshot.outputs?.find(
    (candidate) => candidate.kind === "file" && candidate.stepId === stepId,
  );
  return output?.kind === "file" ? `${output.path} v${output.version}` : null;
}

export interface CrewGateCopy {
  readonly stepId: string;
  readonly kicker: string;
  readonly title: string;
  readonly consequence: string | null;
  /** Who reads a note left with the decision: the next stage's role. */
  readonly noteRecipient: string | null;
}

/** Wording for the approval card of a feature waiting at a gate. */
export function crewGateCopy(snapshot: WorkflowFeatureSnapshot): CrewGateCopy | null {
  const current = crewCurrentStep(snapshot);
  if (snapshot.state !== "approval" || current === null) return null;
  const step = snapshot.definition.steps[current.id];
  if (step?.type !== "task") return null;
  const nextId = current.pendingOutcome ? step.next[current.pendingOutcome] : undefined;
  const next = nextId === undefined ? undefined : snapshot.definition.steps[nextId];
  const stage = humanizeCrewId(current.id);
  return {
    stepId: current.id,
    kicker: `${stage} approval`,
    title: stageArtifact(snapshot, current.id) ?? `${stage} is ready`,
    consequence:
      next === undefined
        ? null
        : next.type === "end"
          ? "Approving finishes the feature."
          : `Approving starts ${humanizeCrewId(nextId!)} with the ${humanizeCrewId(next.role)}.`,
    noteRecipient: next?.type === "task" ? humanizeCrewId(next.role) : null,
  };
}

/** The failure text for the current stage: its last failed event, or the execution error. */
export function crewFailureDetail(snapshot: WorkflowFeatureSnapshot): string | null {
  const current = crewCurrentStep(snapshot);
  const failed = snapshot.recentEvents.findLast(
    (event) => event.kind === "failed" && event.stepId === current?.id,
  );
  return failed?.detail ?? snapshot.executionError ?? null;
}

/** Earlier stages a stage can be sent back to, nearest first. */
export function crewSendBackTargets(
  snapshot: WorkflowFeatureSnapshot,
  stepId: string,
): ReadonlyArray<{ readonly stepId: string; readonly label: string }> {
  const stages = workflowStageIds(snapshot.definition);
  const index = stages.indexOf(stepId);
  const ran = new Set(
    snapshot.steps.filter((step) => step.executionId !== null).map((step) => step.id),
  );
  return stages
    .slice(0, Math.max(index, 0))
    .filter((id) => ran.has(id))
    .reverse()
    .map((id) => ({ stepId: id, label: humanizeCrewId(id) }));
}

/** Routes a taken-over stage can hand on with, for Mark stage done. */
export function crewStageOutcomes(definition: WorkflowDefinition, stepId: string) {
  const step = definition.steps[stepId];
  return step?.type === "task" ? Object.keys(step.next) : [];
}

/** The workflow question the current stage waits on, if a person must answer it. */
export function crewOpenQuestion(snapshot: WorkflowFeatureSnapshot): string | null {
  const current = crewCurrentStep(snapshot);
  if (current?.status !== "needs-input") return null;
  const question = snapshot.recentEvents.findLast(
    (event) => event.kind === "question" && event.executionId === current.executionId,
  );
  return question?.detail ?? null;
}
