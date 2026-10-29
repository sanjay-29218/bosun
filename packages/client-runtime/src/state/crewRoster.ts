import { CREW_STATE_LABELS, featureStageRows, formatStageName } from "../crewStage.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { workGroupLead, type WorkGroup, type WorkGroupThread } from "./workGroups.ts";
import type {
  CrewStageSummary,
  ThreadId,
  WorkflowFeatureSnapshot,
  WorkflowStepSnapshot,
} from "@t3tools/contracts";

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

export type CrewRosterTone = "done" | "working" | "waiting" | "failed" | "idle" | "next";

/** One of a feature's or bot request's crew: its lead, a stage, or a helper a stage asked. */
export interface CrewRosterEntry {
  readonly key: string;
  readonly kind: "lead" | "stage" | "helper";
  /** "Build", "Project manager", "Tester". */
  readonly name: string;
  /** The role that runs a stage, such as "Builder"; null for the lead and helpers. */
  readonly role: string | null;
  readonly threadId: ThreadId | null;
  readonly status: string;
  readonly tone: CrewRosterTone;
  /** A stage's earlier attempts, oldest first. */
  readonly tries: ReadonlyArray<ThreadId>;
  /** The stage the feature is on. */
  readonly active: boolean;
  readonly gate: boolean;
}

const STEP_STATUS: Record<
  WorkflowStepSnapshot["status"],
  { readonly label: string; readonly tone: CrewRosterTone }
> = {
  pending: { label: "Next", tone: "next" },
  running: { label: "Working", tone: "working" },
  "needs-input": { label: "Input", tone: "waiting" },
  completed: { label: "Done", tone: "done" },
  failed: { label: "Failed", tone: "failed" },
  cancelled: { label: "Cancelled", tone: "idle" },
  "awaiting-approval": { label: "Approval", tone: "waiting" },
  "limit-reached": { label: "Your call", tone: "waiting" },
  "taken-over": { label: "Yours", tone: "waiting" },
  skipped: { label: "Skipped", tone: "idle" },
};

export const CREW_STATE_TONES: Record<CrewStageSummary["state"], CrewRosterTone> = {
  working: "working",
  queued: "working",
  approval: "waiting",
  input: "waiting",
  "your-call": "waiting",
  failed: "failed",
  paused: "idle",
  cancelled: "idle",
  done: "done",
};

function threadStatus(thread: CrewRosterThread) {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return { status: "Approval", tone: "waiting" as const };
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return { status: "Input", tone: "waiting" as const };
  }
  if (thread.runtime?.status === "idle") return { status: "Waiting", tone: "idle" as const };
  if (threadRuntimeIsActive(thread.runtime)) return { status: "Working", tone: "working" as const };
  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") {
    return { status: "Failed", tone: "failed" as const };
  }
  return { status: "Idle", tone: "idle" as const };
}

function threadEntry(
  thread: CrewRosterThread,
  kind: "lead" | "helper",
  name: string,
): CrewRosterEntry {
  return {
    key: thread.id,
    kind,
    name,
    role: null,
    threadId: thread.id,
    ...threadStatus(thread),
    tries: [],
    active: false,
    gate: false,
  };
}

/**
 * Everyone working on a feature or bot request, in the order you'd follow them: the lead, then
 * each stage of the workflow (from the feature's snapshot when it has loaded), then helpers.
 * Subagents are not here; they belong to the thread that started them.
 */
export function buildCrewRoster<T extends CrewRosterThread>(
  group: WorkGroup<T>,
  snapshot: WorkflowFeatureSnapshot | null,
): ReadonlyArray<CrewRosterEntry> {
  const threads = [group.primary, ...group.children.map((entry) => entry.thread)].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  );
  const lead = workGroupLead(group);
  const leadEntry = lead ? [threadEntry(lead, "lead", lead.crewRequest?.member ?? lead.title)] : [];
  if (group.kind === "request") {
    // The lead is the latest attempt of the first role; its earlier attempts follow it.
    const seen = new Map<string, number>();
    return [
      ...leadEntry,
      ...threads.flatMap((thread) => {
        if (thread === lead) return [];
        const member = thread.crewRequest?.member ?? thread.title;
        if (member === lead?.crewRequest?.member) {
          return [threadEntry(thread, "helper", `${member} · earlier try`)];
        }
        const attempt = (seen.get(member) ?? 0) + 1;
        seen.set(member, attempt);
        return [threadEntry(thread, "helper", attempt > 1 ? `${member} · try ${attempt}` : member)];
      }),
    ];
  }
  const stageThreads = threads.filter((thread) => thread.crew);
  const stages: ReadonlyArray<CrewRosterEntry> = snapshot
    ? featureStageRows(snapshot).map((row) => ({
        key: `stage:${row.stepId}`,
        kind: "stage" as const,
        name: row.name,
        role: row.role,
        threadId: row.threadId,
        status: STEP_STATUS[row.status].label,
        tone: STEP_STATUS[row.status].tone,
        tries: stageThreads
          .filter((thread) => thread.crew?.stepId === row.stepId && thread.id !== row.threadId)
          .map((thread) => thread.id),
        active: row.active,
        gate: row.gate,
      }))
    : // Until the snapshot loads, the stage threads stand in, without stages yet to start.
      stageThreads
        .filter(
          (thread, index, all) =>
            all.findLastIndex((other) => other.crew?.stepId === thread.crew?.stepId) === index,
        )
        .sort((left, right) => left.crew!.index - right.crew!.index)
        .map((thread) => ({
          key: `stage:${thread.crew!.stepId}`,
          kind: "stage" as const,
          name: formatStageName(thread.crew!.stepId),
          role: null,
          threadId: thread.id,
          ...(thread.crew!.current
            ? {
                status: CREW_STATE_LABELS[thread.crew!.state],
                tone: CREW_STATE_TONES[thread.crew!.state],
              }
            : { status: "Done", tone: "done" as const }),
          tries: stageThreads
            .filter((other) => other.crew?.stepId === thread.crew!.stepId && other !== thread)
            .map((other) => other.id),
          active: thread.crew!.current,
          gate: false,
        }));
  const helpers = threads
    .filter((thread) => !thread.crew && thread !== lead)
    .map((thread) => threadEntry(thread, "helper", thread.crewRequest?.member ?? thread.title));
  return [...leadEntry, ...stages, ...helpers];
}
