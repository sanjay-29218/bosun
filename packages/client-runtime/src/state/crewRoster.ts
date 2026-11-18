import { FEATURE_STATUS_LABELS, threadFailed, type CrewStatus } from "./crewBoard.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { workGroupLead, type WorkGroup, type WorkGroupThread } from "./workGroups.ts";
import type { ThreadId } from "@t3tools/contracts";

/** The thread fields the roster reads. */
export type CrewRosterThread = WorkGroupThread & {
  readonly id: ThreadId;
} & Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "runtime"
    | "latestRun"
  >;

/** One of a feature's or bot request's crew: its lead, or a member it handed work to. */
export interface CrewRosterEntry {
  readonly key: string;
  readonly kind: "lead" | "member";
  /** "Feature manager", "Planner", "Planner · try 2". */
  readonly name: string;
  readonly threadId: ThreadId;
  /** Its status word, such as "Needs input". */
  readonly status: string;
  readonly tone: CrewStatus;
}

/**
 * A pending approval or question is Needs input. A member's finished turn reported back to its
 * lead, so it's Done; a lead that stopped, or a member that hasn't run, is Waiting.
 */
export function crewThreadStatus(thread: CrewRosterThread, kind: "lead" | "member"): CrewStatus {
  if (
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.pendingSubagentRequest != null
  ) {
    return "needs-input";
  }
  if (threadRuntimeIsActive(thread.runtime)) return "working";
  if (threadFailed(thread)) return "failed";
  return kind === "member" && thread.latestRun?.status === "completed" ? "done" : "waiting";
}

function threadEntry(
  thread: CrewRosterThread,
  kind: "lead" | "member",
  name: string,
): CrewRosterEntry {
  const tone = crewThreadStatus(thread, kind);
  return {
    key: thread.id,
    kind,
    name,
    threadId: thread.id,
    status: FEATURE_STATUS_LABELS[tone],
    tone,
  };
}

/**
 * Everyone working on a feature or bot request, in the order you'd follow them: the lead, then
 * the threads it handed work to, oldest first. Plain subagents belong to the thread that
 * started them and are not here.
 */
export function buildCrewRoster<T extends CrewRosterThread>(
  group: WorkGroup<T>,
): ReadonlyArray<CrewRosterEntry> {
  const nameOf = (thread: T) =>
    thread.feature?.member ?? thread.crewRequest?.member ?? thread.title;
  const lead = workGroupLead(group);
  return [
    ...(lead ? [threadEntry(lead, "lead", nameOf(lead))] : []),
    ...[{ thread: group.primary, label: nameOf(group.primary) }, ...group.children]
      .filter((entry) => entry.thread !== lead)
      .map((entry) =>
        threadEntry(
          entry.thread,
          "member",
          group.kind === "request" && entry.thread.crewRequest?.member === lead?.crewRequest?.member
            ? `${entry.label} · earlier try`
            : entry.label,
        ),
      ),
  ];
}
