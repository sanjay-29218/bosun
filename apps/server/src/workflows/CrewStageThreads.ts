import type {
  CrewStageSummary,
  FeatureCardState,
  ThreadId,
  WorkflowDefinition,
  WorkflowStepEvent,
} from "@t3tools/contracts";

import { stagePosition } from "./WorkflowState.ts";

/**
 * The board summary for every thread a feature's stages ran in. Each attempt runs in its own
 * thread, labelled with its own stage. The thread of the latest start is `current`, so the
 * sidebar keeps exactly one row per feature, including between stages and after it ends.
 */
export const stageThreadSummaries = (input: {
  readonly featureId: string;
  readonly definition: WorkflowDefinition;
  readonly events: ReadonlyArray<WorkflowStepEvent>;
  readonly state: FeatureCardState;
  /** The feature's event version, carried by the current thread only. */
  readonly revision: number;
  readonly runThreads: ReadonlyMap<string, ThreadId>;
}): ReadonlyArray<{ readonly threadId: ThreadId; readonly summary: CrewStageSummary }> => {
  const stepByThread = new Map<ThreadId, string>();
  let currentThreadId: ThreadId | null = null;
  for (const event of input.events) {
    if (event.kind !== "started" || event.runId === null) continue;
    const threadId = input.runThreads.get(event.runId);
    if (threadId === undefined) continue;
    // Re-insert so the map keeps the order threads last started in.
    stepByThread.delete(threadId);
    stepByThread.set(threadId, event.stepId);
    currentThreadId = threadId;
  }
  return [...stepByThread].flatMap(([threadId, stepId]) => {
    const position = stagePosition(input.definition, stepId);
    if (position === null) return [];
    return [
      {
        threadId,
        summary: {
          featureId: input.featureId,
          ...position,
          state: input.state,
          current: threadId === currentThreadId,
          // Only the current thread follows the feature; see syncStageThreads.
          ...(threadId === currentThreadId ? { revision: input.revision } : {}),
        },
      },
    ];
  });
};
