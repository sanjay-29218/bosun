import type { WorkRowStatus } from "@t3tools/client-runtime/state/crew-board";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/** Whether a Lineage row's thread waits on the person's approval or answer. */
export function threadAsksPerson(
  thread: Partial<Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">> | null | undefined,
): boolean {
  const request = thread?.pendingRuntimeRequest;
  return request != null && request.kind !== "auth_refresh";
}

/**
 * A Lineage row's status. A feature lead reads as its sidebar row does while it works, asks or
 * fails; once stopped it reads as its feature does on the board (`featureStatus`), so Done only
 * once merged. Any other thread asking the person reads Needs input even while its run runs; the
 * rest take their run's status.
 */
export function relationshipRowStatus(row: {
  readonly featureLead: Parameters<typeof resolveSidebarThreadStatus>[0] | undefined;
  /** The lead's feature's status, from `featureWorkStatus`; null without its board card. */
  readonly featureStatus?: WorkRowStatus | null;
  readonly asking: boolean;
  readonly runStatus: string | null;
}): string | null {
  if (row.featureLead === undefined) return row.asking ? "needs_input" : row.runStatus;
  switch (resolveSidebarThreadStatus(row.featureLead)) {
    case "approval":
    case "input":
      return "needs_input";
    case "working":
      return "running";
    case "failed":
    case "limited":
      return "failed";
    case "ready":
      // Without its board card, a lead that finished its turn is up for review, never Done.
      return row.featureStatus == null ? "ready_for_review" : boardStatus(row.featureStatus);
    default:
      return row.featureStatus == null ? "waiting" : boardStatus(row.featureStatus);
  }
}

const boardStatus = (status: WorkRowStatus) =>
  status === "review" ? "ready_for_review" : status === "done" ? "completed" : "waiting";
