import type {
  CrewStageSummary,
  FeatureCardState,
  ThreadId,
  WorkflowFeatureSnapshot,
  WorkflowStepSnapshot,
} from "@t3tools/contracts";

/**
 * Stage threads: what web and mobile show for a thread that runs one stage of a feature.
 * The server's workflow fold decides which actions are legal; these helpers mirror its rules
 * so menus only offer what the server will accept.
 */

const ACRONYMS = new Set(["qa", "ui", "ux", "pr", "api"]);

/** `change_review` → "Change review", `qa` → "QA". */
export function formatStageName(stepId: string): string {
  const words = stepId.split(/[\s_-]+/u).filter(Boolean);
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
}

/** Line 3 of a sidebar row: "Design · 2/6". */
export function formatCrewStageLine(crew: Pick<CrewStageSummary, "stepId" | "index" | "total">) {
  return `${formatStageName(crew.stepId)} · ${crew.index}/${crew.total}`;
}

/** Earlier stage threads stay reachable through the breadcrumb and the Feature tab. */
export function isHiddenStageThread(thread: {
  readonly crew?: Pick<CrewStageSummary, "current"> | null;
}): boolean {
  return thread.crew != null && !thread.crew.current;
}

/** The board states that wait on a person, in the words the sidebar shows. */
export const CREW_STATE_LABELS: Record<FeatureCardState, string> = {
  working: "Working",
  queued: "Queued",
  approval: "Approval",
  input: "Input",
  "your-call": "Your call",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
  done: "Done",
};

export type CrewAction =
  | "approve"
  | "request-changes"
  | "retry"
  | "take-over"
  | "mark-done"
  | "send-back"
  | "skip"
  | "accept-as-is"
  | "one-more-round"
  | "pause"
  | "resume"
  | "cancel"
  | "reopen"
  | "start-now";

export function activeStep(snapshot: WorkflowFeatureSnapshot): WorkflowStepSnapshot | null {
  return snapshot.steps.find((step) => step.id === snapshot.activeStepId) ?? null;
}

const statusIn = (
  step: WorkflowStepSnapshot | null,
  ...statuses: WorkflowStepSnapshot["status"][]
) => step !== null && statuses.includes(step.status);

/** Earlier stages a stuck stage can send work back to, in workflow order. */
export function sendBackTargets(snapshot: WorkflowFeatureSnapshot): ReadonlyArray<string> {
  const steps = new Map(snapshot.steps.map((step) => [step.id, step]));
  return Object.keys(snapshot.definition.steps).filter((id) => {
    const step = steps.get(id);
    return (
      id !== snapshot.activeStepId &&
      snapshot.definition.steps[id]?.type === "task" &&
      (step?.status === "completed" || step?.status === "skipped")
    );
  });
}

/** Every action the feature accepts right now, matching WorkflowState's transitions. */
export function availableCrewActions(snapshot: WorkflowFeatureSnapshot): ReadonlyArray<CrewAction> {
  if (snapshot.completed || snapshot.cancelled) return ["reopen"];
  const step = activeStep(snapshot);
  const actions: Array<CrewAction> = [];
  if (statusIn(step, "awaiting-approval")) actions.push("approve", "request-changes");
  if (statusIn(step, "limit-reached")) actions.push("accept-as-is", "one-more-round");
  if (statusIn(step, "failed", "taken-over")) actions.push("retry");
  if (statusIn(step, "taken-over")) actions.push("mark-done");
  if (statusIn(step, "running", "needs-input", "failed", "awaiting-approval", "limit-reached"))
    actions.push("take-over");
  if (
    statusIn(step, "failed", "limit-reached", "awaiting-approval", "taken-over") &&
    sendBackTargets(snapshot).length > 0
  )
    actions.push("send-back");
  if (statusIn(step, "pending", "failed", "limit-reached")) actions.push("skip");
  if (snapshot.state === "queued") actions.push("start-now");
  actions.push(snapshot.paused ? "resume" : "pause", "cancel");
  return actions;
}

const lastEvent = (
  snapshot: WorkflowFeatureSnapshot,
  stepId: string,
  kind: WorkflowFeatureSnapshot["recentEvents"][number]["kind"],
) => snapshot.recentEvents.findLast((event) => event.stepId === stepId && event.kind === kind);

/** What the composer banner of a stage thread asks of the person, if anything. */
export type CrewStagePrompt =
  | { readonly kind: "gate"; readonly stepId: string; readonly summary: string | null }
  | {
      readonly kind: "failure";
      readonly stepId: string;
      readonly attempt: number;
      readonly error: string | null;
    }
  | {
      readonly kind: "your-call";
      readonly stepId: string;
      readonly reason: "loop-limit" | "execution-limit";
      readonly target: string;
    }
  | {
      readonly kind: "taken-over";
      readonly stepId: string;
      readonly outcomes: ReadonlyArray<string>;
    };

/** Banners show only in the thread running the active stage. */
export function crewStagePrompt(
  snapshot: WorkflowFeatureSnapshot,
  threadId: ThreadId,
): CrewStagePrompt | null {
  if (snapshot.completed || snapshot.cancelled) return null;
  const step = activeStep(snapshot);
  if (!step || step.threadId !== threadId) return null;
  switch (step.status) {
    case "awaiting-approval":
      return {
        kind: "gate",
        stepId: step.id,
        summary: lastEvent(snapshot, step.id, "completed")?.detail ?? null,
      };
    case "failed":
      return {
        kind: "failure",
        stepId: step.id,
        attempt: step.attempt,
        error: lastEvent(snapshot, step.id, "failed")?.detail ?? null,
      };
    case "limit-reached":
      return snapshot.yourCall
        ? {
            kind: "your-call",
            stepId: step.id,
            reason: snapshot.yourCall.reason,
            target: snapshot.yourCall.target,
          }
        : null;
    case "taken-over": {
      const task = snapshot.definition.steps[step.id];
      return {
        kind: "taken-over",
        stepId: step.id,
        outcomes: task?.type === "task" ? Object.keys(task.next) : [],
      };
    }
    default:
      return null;
  }
}

export interface FeatureStageRow {
  readonly stepId: string;
  readonly name: string;
  readonly bot: string;
  readonly status: WorkflowStepSnapshot["status"];
  readonly attempt: number;
  readonly threadId: ThreadId | null;
  readonly active: boolean;
  readonly gate: boolean;
}

/** The workflow's stages in definition order, as the Feature tab and breadcrumb list them. */
export function featureStageRows(
  snapshot: WorkflowFeatureSnapshot,
): ReadonlyArray<FeatureStageRow> {
  const steps = new Map(snapshot.steps.map((step) => [step.id, step]));
  return Object.entries(snapshot.definition.steps).flatMap(([stepId, task]) => {
    if (task.type !== "task") return [];
    const step = steps.get(stepId);
    return [
      {
        stepId,
        name: formatStageName(stepId),
        bot: formatStageName(task.bot),
        status: step?.status ?? "pending",
        attempt: step?.attempt ?? 0,
        threadId: step?.threadId ?? null,
        active: stepId === snapshot.activeStepId,
        gate: task.gate === true,
      },
    ];
  });
}

/**
 * One line for the composer's Workflow picker: "Plan → approve → Design → Build → Review".
 * Follows each stage's first route from the start, so loops and rework branches are left out.
 */
export function workflowSummaryLine(definition: WorkflowFeatureSnapshot["definition"]): string {
  const parts: Array<string> = [];
  const seen = new Set<string>();
  let stepId: string | undefined = definition.start;
  while (stepId !== undefined && !seen.has(stepId)) {
    seen.add(stepId);
    const step: WorkflowFeatureSnapshot["definition"]["steps"][string] | undefined =
      definition.steps[stepId];
    if (step?.type !== "task") break;
    parts.push(formatStageName(stepId));
    if (step.gate) parts.push("approve");
    stepId = Object.values(step.next)[0];
  }
  return parts.join(" → ");
}
