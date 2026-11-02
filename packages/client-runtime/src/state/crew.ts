import type {
  ThreadId,
  WorkflowDefinition,
  WorkflowFeatureSnapshot,
  WorkflowStepSnapshot,
} from "@t3tools/contracts";

/**
 * Stage-card logic for an open stage thread. Everything here is pure: it reads one feature's
 * workflow snapshot.
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

function crewCurrentStep(snapshot: WorkflowFeatureSnapshot): WorkflowStepSnapshot | null {
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
