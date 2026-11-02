import type {
  CrewStageSummary,
  FeatureCardState,
  ThreadId,
  WorkflowFeatureSnapshot,
  WorkflowStepSnapshot,
} from "@t3tools/contracts";
import { formatStageName } from "@t3tools/shared/crewStage";

/**
 * Stage threads: what web and mobile show for a thread that runs one stage of a feature.
 * The server's workflow fold decides which actions are legal; these helpers mirror its rules
 * so menus only offer what the server will accept.
 */

export {
  availableCrewActions,
  CREW_ACTION_COPY,
  crewStagePrompt,
  formatStageName,
  sendBackTargets,
  type CrewAction,
  type CrewStagePrompt,
} from "@t3tools/shared/crewStage";
/** Line 3 of a sidebar row: "Design · 2/6". */
export function formatCrewStageLine(crew: Pick<CrewStageSummary, "stepId" | "index" | "total">) {
  return `${formatStageName(crew.stepId)} · ${crew.index}/${crew.total}`;
}

// Tailwind 500 hues that read on both themes.
const FEATURE_TAG_COLORS = [
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#0ea5e9",
  "#6366f1",
  "#a855f7",
  "#ec4899",
];

/** A feature tag's color: its ID hashed into a fixed palette, so every client agrees. */
export function featureTagColor(featureId: string): string {
  let hash = 0;
  for (let index = 0; index < featureId.length; index += 1) {
    hash = (hash * 31 + featureId.charCodeAt(index)) >>> 0;
  }
  return FEATURE_TAG_COLORS[hash % FEATURE_TAG_COLORS.length]!;
}

/** Earlier stage threads stay reachable through the breadcrumb and the Feature tab. */
export function isHiddenStageThread(thread: {
  readonly crew?: Pick<CrewStageSummary, "current"> | null;
}): boolean {
  return thread.crew != null && !thread.crew.current;
}

/**
 * Changes whenever an open stage thread should reload its feature. Nothing streams: the current
 * stage thread's `crew.revision` moves with every decision, and its run status with every run.
 */
export function crewStageRefreshKey(
  crew: CrewStageSummary | null | undefined,
  latestRunStatus: string | undefined,
): string | null {
  return crew
    ? `${crew.featureId}:${crew.stepId}:${crew.state}:${crew.current}:${crew.revision}:${latestRunStatus}`
    : null;
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
  cancelled: "Stopped",
  done: "Done",
};

export interface FeatureStageRow {
  readonly stepId: string;
  readonly name: string;
  readonly role: string;
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
        role: formatStageName(task.role),
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

export interface WorkflowStageOverview {
  readonly stepId: string;
  readonly name: string;
  readonly role: string;
  readonly gate: boolean;
  /** Where each outcome goes: "ready → Design", "passed → Done", with any route limit. */
  readonly routes: ReadonlyArray<string>;
}

/** A workflow's stages in definition order, for a read-only view of the workflow. */
export function workflowStageOverview(
  definition: WorkflowFeatureSnapshot["definition"],
): ReadonlyArray<WorkflowStageOverview> {
  return Object.entries(definition.steps).flatMap(([stepId, step]) => {
    if (step.type !== "task") return [];
    return [
      {
        stepId,
        name: formatStageName(stepId),
        role: formatStageName(step.role),
        gate: step.gate === true,
        routes: Object.entries(step.next).map(([outcome, target]) => {
          const to = definition.steps[target]?.type === "end" ? "Done" : formatStageName(target);
          const limit = step.limits?.[outcome];
          return limit === undefined
            ? `${outcome} → ${to}`
            : `${outcome} → ${to} (up to ${limit}×)`;
        }),
      },
    ];
  });
}
