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
 * A Lineage row's status. A feature lead reads as its sidebar row does, so one whose crew works
 * waits; any other thread asking the person reads Needs input even while its run runs; the rest
 * take their run's status.
 */
export function relationshipRowStatus(row: {
  readonly featureLead: Parameters<typeof resolveSidebarThreadStatus>[0] | undefined;
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
      return "completed";
    default:
      return "waiting";
  }
}
