import type { OrchestrationV2AppThread, OrchestrationV2Subagent } from "@t3tools/contracts";

/**
 * Whether a thread finishing is no news, so no client announces it: its owner reports the result
 * (crew and delegated tasks to their parent, a child feature to its parent's lead), or the turn its
 * owed delegated results wake follows. Questions, approvals and failures are never quiet.
 */
export function isQuietCompletion(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "feature" | "delegatedFrom">;
  /** A delegated task of this thread ended and its result hasn't reached the thread yet. */
  readonly delegatedResultOwed: boolean;
}): boolean {
  const { thread } = input;
  return (
    input.delegatedResultOwed ||
    thread.lineage.relationshipToParent === "subagent" ||
    thread.delegatedFrom !== undefined ||
    thread.feature?.member !== undefined ||
    thread.feature?.parentFeatureId !== undefined
  );
}

/** A task that ended with its result still to be delivered; the shell SQL's `delegated_result_owed`. */
export const delegatedResultOwed = (
  task: Pick<OrchestrationV2Subagent, "status" | "completionDelivery">,
): boolean =>
  (task.status === "completed" ||
    task.status === "failed" ||
    task.status === "cancelled" ||
    task.status === "interrupted") &&
  (task.completionDelivery?.state === "pending" || task.completionDelivery?.state === "claimed");
