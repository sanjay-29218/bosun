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

export type CrewRosterTone = "done" | "working" | "waiting" | "failed" | "idle";

/** One of a feature's or bot request's crew: its lead, or a member it handed work to. */
export interface CrewRosterEntry {
  readonly key: string;
  readonly kind: "lead" | "member";
  /** "Project manager", "Planner", "Planner · try 2". */
  readonly name: string;
  readonly threadId: ThreadId;
  readonly status: string;
  readonly tone: CrewRosterTone;
}

function threadStatus(thread: CrewRosterThread, kind: "lead" | "member") {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return { status: "Approval", tone: "waiting" as const };
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return { status: "Input", tone: "waiting" as const };
  }
  if (threadRuntimeIsActive(thread.runtime)) return { status: "Working", tone: "working" as const };
  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") {
    return { status: "Failed", tone: "failed" as const };
  }
  // A member's finished turn reported to the lead; a lead that stopped is waiting on the person.
  if (thread.latestRun?.status === "completed") {
    return kind === "lead"
      ? { status: "Your turn", tone: "waiting" as const }
      : { status: "Done", tone: "done" as const };
  }
  if (thread.runtime?.status === "idle") return { status: "Waiting", tone: "idle" as const };
  return { status: "Idle", tone: "idle" as const };
}

function threadEntry(
  thread: CrewRosterThread,
  kind: "lead" | "member",
  name: string,
): CrewRosterEntry {
  return { key: thread.id, kind, name, threadId: thread.id, ...threadStatus(thread, kind) };
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
