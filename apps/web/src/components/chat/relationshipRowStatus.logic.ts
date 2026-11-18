import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/**
 * A Lineage row's status. Any thread asking the person reads Needs input, even while its run
 * runs; a feature lead reads as its sidebar row does, so one whose crew works waits; other rows
 * take their run's status.
 */
export function relationshipRowStatus(row: {
  readonly shell: Parameters<typeof resolveSidebarThreadStatus>[0] | undefined;
  readonly featureLead: boolean;
  readonly runStatus: string | null;
}): string | null {
  const sidebar = row.shell ? resolveSidebarThreadStatus(row.shell) : null;
  if (sidebar === "approval" || sidebar === "input") return "needs_input";
  if (!row.featureLead || sidebar === null) return row.runStatus;
  switch (sidebar) {
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
