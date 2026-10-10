import type {
  CrewStageSummary,
  FeatureCardState,
  FeatureRecord,
  WorkflowDefinition,
  WorkflowFeatureSnapshot,
  WorkflowStepSnapshot,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

/**
 * Crew mode view logic shared by web and mobile. Everything here is pure: it reads a
 * project's feature board (records plus their workflow snapshots) and derives the rows,
 * groups and card wording the clients render.
 */

export interface CrewFeature {
  readonly record: typeof FeatureRecord.Type;
  /** Null for a feature without a workflow. */
  readonly snapshot: WorkflowFeatureSnapshot | null;
}

export interface CrewStageThread {
  readonly threadId: ThreadId;
  readonly feature: CrewFeature;
  readonly summary: CrewStageSummary;
}

/** States that wait on a person, in the order Needs you lists their kinds. */
export const NEEDS_YOU_STATES: ReadonlyArray<FeatureCardState> = [
  "approval",
  "your-call",
  "failed",
  "input",
];

/** Task steps in definition order, which is how the server counts stage positions. */
export function workflowStageIds(definition: WorkflowDefinition): ReadonlyArray<string> {
  return Object.keys(definition.steps).filter((id) => definition.steps[id]?.type === "task");
}

/** Workflows name stages by step id: `change_review` reads "Change review". */
export function humanizeCrewId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? id : words[0]!.toUpperCase() + words.slice(1);
}

export function crewStageRole(definition: WorkflowDefinition, stepId: string): string | null {
  const step = definition.steps[stepId];
  return step?.type === "task" ? humanizeCrewId(step.bot) : null;
}

/**
 * Thread ids of earlier executions, from the runs the recent events started. Snapshots only
 * keep each stage's latest run, so a reworked stage's old thread is recovered by applying the
 * run-to-thread naming its current run shows.
 */
function earlierStageThreads(
  snapshot: WorkflowFeatureSnapshot,
): ReadonlyArray<{ readonly threadId: ThreadId; readonly stepId: string }> {
  const sample = snapshot.steps.find(
    (step) =>
      step.botRunId !== null && step.threadId !== null && step.threadId.endsWith(step.botRunId),
  );
  if (!sample?.botRunId || !sample.threadId) return [];
  const prefix = sample.threadId.slice(0, sample.threadId.length - sample.botRunId.length);
  const latest = new Set(snapshot.steps.map((step) => step.botRunId));
  const earlier = new Map<string, string>();
  for (const event of snapshot.recentEvents) {
    if (event.kind === "started" && event.botRunId !== null && !latest.has(event.botRunId)) {
      earlier.set(event.botRunId, event.stepId);
    }
  }
  return [...earlier].map(([runId, stepId]) => ({
    threadId: ThreadId.make(`${prefix}${runId}`),
    stepId,
  }));
}

/**
 * One summary per stage thread the snapshot knows. Exactly one is `current`: the thread the
 * feature's row stands for (see `crewCurrentThreadId`).
 */
export function crewStageThreads(feature: CrewFeature): ReadonlyArray<CrewStageThread> {
  const snapshot = feature.snapshot;
  if (snapshot === null) return [];
  const stages = workflowStageIds(snapshot.definition);
  const state = snapshot.state ?? "working";
  const representative = crewCurrentThreadId(feature);
  const threads: CrewStageThread[] = [];
  const add = (threadId: ThreadId, stepId: string) => {
    const index = stages.indexOf(stepId);
    if (index < 0) return;
    threads.push({
      threadId,
      feature,
      summary: {
        featureId: snapshot.featureId,
        stepId,
        index: index + 1,
        total: stages.length,
        state,
        current: threadId === representative,
      },
    });
  };
  for (const step of snapshot.steps) {
    if (step.threadId !== null) add(step.threadId, step.id);
  }
  for (const earlier of earlierStageThreads(snapshot)) add(earlier.threadId, earlier.stepId);
  return threads;
}

/** Line 3 of a stage thread's row: "Design · 2/6 · Designer". */
export function crewStageLine(definition: WorkflowDefinition, summary: CrewStageSummary): string {
  const role = crewStageRole(definition, summary.stepId);
  return [
    humanizeCrewId(summary.stepId),
    `${summary.index}/${summary.total}`,
    ...(role === null ? [] : [role]),
  ].join(" · ");
}

export function crewFeatureState(feature: CrewFeature): FeatureCardState {
  if (feature.snapshot?.state) return feature.snapshot.state;
  return feature.record.status === "closed" ? "done" : "working";
}

/** When the feature entered its current state; Needs you lists the oldest first. */
export function crewFeatureStateSince(feature: CrewFeature): string {
  const events = feature.snapshot?.recentEvents ?? [];
  return events.at(-1)?.occurredAt ?? feature.record.updatedAt;
}

export function crewCurrentStep(snapshot: WorkflowFeatureSnapshot): WorkflowStepSnapshot | null {
  const stepId = snapshot.stage?.stepId ?? null;
  return stepId === null ? null : (snapshot.steps.find((step) => step.id === stepId) ?? null);
}

/**
 * The thread a feature's row opens: its current stage's thread, or, while the next stage has
 * none yet (queued) or the feature is done, the stage thread that started most recently.
 */
export function crewCurrentThreadId(feature: CrewFeature): ThreadId | null {
  const snapshot = feature.snapshot;
  if (snapshot === null) return null;
  const current = crewCurrentStep(snapshot)?.threadId ?? null;
  if (current !== null) return current;
  const withThread = snapshot.steps.filter((step) => step.threadId !== null);
  const lastStarted = snapshot.recentEvents.findLast(
    (event) => event.kind === "started" && withThread.some((step) => step.id === event.stepId),
  );
  if (lastStarted) return withThread.find((step) => step.id === lastStarted.stepId)!.threadId;
  const stages = workflowStageIds(snapshot.definition);
  return (
    withThread.sort((a, b) => stages.indexOf(b.id) - stages.indexOf(a.id))[0]?.threadId ?? null
  );
}

export function crewNeedsYou(features: ReadonlyArray<CrewFeature>): ReadonlyArray<CrewFeature> {
  return features
    .filter((feature) => NEEDS_YOU_STATES.includes(crewFeatureState(feature)))
    .sort((a, b) => crewFeatureStateSince(a).localeCompare(crewFeatureStateSince(b)));
}

export interface CrewFeatureGroup {
  readonly key: string;
  readonly label: string;
  readonly features: ReadonlyArray<CrewFeature>;
}

const FINISHED_STATES: ReadonlyArray<FeatureCardState> = ["done", "cancelled"];

/**
 * Features that don't need a person, grouped by the stage they are at. Stages of different
 * workflows share a group by name; groups follow stage order and Done comes last.
 */
export function crewGroupByPhase(
  features: ReadonlyArray<CrewFeature>,
): ReadonlyArray<CrewFeatureGroup> {
  const groups = new Map<string, { order: number; features: CrewFeature[] }>();
  const done: CrewFeature[] = [];
  for (const feature of features) {
    const state = crewFeatureState(feature);
    if (NEEDS_YOU_STATES.includes(state)) continue;
    const stage = feature.snapshot?.stage ?? null;
    if (FINISHED_STATES.includes(state) || stage === null) {
      done.push(feature);
      continue;
    }
    const group = groups.get(stage.stepId) ?? { order: stage.index, features: [] };
    group.order = Math.min(group.order, stage.index);
    group.features.push(feature);
    groups.set(stage.stepId, group);
  }
  const byRecent = (a: CrewFeature, b: CrewFeature) =>
    b.record.updatedAt.localeCompare(a.record.updatedAt);
  return [
    ...[...groups.entries()]
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([stepId, group]) => ({
        key: stepId,
        label: humanizeCrewId(stepId),
        features: group.features.sort(byRecent),
      })),
    ...(done.length === 0 ? [] : [{ key: "done", label: "Done", features: done.sort(byRecent) }]),
  ];
}

export type CrewStageGroupItem =
  | ({ readonly kind: "stage" } & CrewFeatureGroup)
  | {
      readonly kind: "gate";
      readonly key: string;
      readonly label: string;
      readonly waiting: number;
    };

/**
 * One workflow's stages in order, each followed by its gate when it has one. Features on
 * other workflows are only counted.
 */
export function crewGroupByStage(
  features: ReadonlyArray<CrewFeature>,
  definition: WorkflowDefinition,
): { readonly items: ReadonlyArray<CrewStageGroupItem>; readonly hiddenCount: number } {
  const byStage = new Map<string, CrewFeature[]>();
  const done: CrewFeature[] = [];
  let hiddenCount = 0;
  for (const feature of features) {
    if (feature.record.workflowId !== definition.id) {
      hiddenCount += 1;
      continue;
    }
    const stepId = feature.snapshot?.stage?.stepId ?? null;
    if (FINISHED_STATES.includes(crewFeatureState(feature)) || stepId === null) {
      done.push(feature);
      continue;
    }
    byStage.set(stepId, [...(byStage.get(stepId) ?? []), feature]);
  }
  const items: CrewStageGroupItem[] = [];
  for (const stepId of workflowStageIds(definition)) {
    const stageFeatures = byStage.get(stepId) ?? [];
    items.push({
      kind: "stage",
      key: stepId,
      label: humanizeCrewId(stepId),
      features: stageFeatures,
    });
    const step = definition.steps[stepId];
    if (step?.type === "task" && step.gate === true) {
      items.push({
        kind: "gate",
        key: `gate:${stepId}`,
        label: `Approve ${humanizeCrewId(stepId).toLocaleLowerCase()}`,
        waiting: stageFeatures.filter((feature) => crewFeatureState(feature) === "approval").length,
      });
    }
  }
  // Features on another version of this workflow can sit at a stage this version lacks.
  const known = new Set(workflowStageIds(definition));
  for (const [stepId, stageFeatures] of byStage) {
    if (known.has(stepId)) continue;
    items.push({
      kind: "stage",
      key: stepId,
      label: `${humanizeCrewId(stepId)} (other version)`,
      features: stageFeatures,
    });
  }
  if (done.length > 0) items.push({ kind: "stage", key: "done", label: "Done", features: done });
  return { items, hiddenCount };
}

/** The workflow most features in view run, for the Workflow switch's default. */
export function crewMostUsedWorkflowId(features: ReadonlyArray<CrewFeature>): string | null {
  const counts = new Map<string, number>();
  for (const feature of features) {
    const id = feature.record.workflowId;
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** Latest version of a stage's first declared output, such as "design.md v2". */
function stageArtifact(snapshot: WorkflowFeatureSnapshot, stepId: string): string | null {
  const output = snapshot.outputs?.find(
    (candidate) => candidate.kind === "file" && candidate.stepId === stepId,
  );
  return output?.kind === "file" ? `${output.path} v${output.version}` : null;
}

export interface CrewGateCopy {
  readonly stepId: string;
  readonly kicker: string;
  readonly title: string;
  readonly consequence: string | null;
  /** Who reads a note left with the decision: the next stage's role. */
  readonly noteRecipient: string | null;
}

/** Wording for the approval card of a feature waiting at a gate. */
export function crewGateCopy(snapshot: WorkflowFeatureSnapshot): CrewGateCopy | null {
  const current = crewCurrentStep(snapshot);
  if (snapshot.state !== "approval" || current === null) return null;
  const step = snapshot.definition.steps[current.id];
  if (step?.type !== "task") return null;
  const nextId = current.pendingOutcome ? step.next[current.pendingOutcome] : undefined;
  const next = nextId === undefined ? undefined : snapshot.definition.steps[nextId];
  const stage = humanizeCrewId(current.id);
  return {
    stepId: current.id,
    kicker: `${stage} approval`,
    title: stageArtifact(snapshot, current.id) ?? `${stage} is ready`,
    consequence:
      next === undefined
        ? null
        : next.type === "end"
          ? "Approving finishes the feature."
          : `Approving starts ${humanizeCrewId(nextId!)} with the ${humanizeCrewId(next.bot)}.`,
    noteRecipient: next?.type === "task" ? humanizeCrewId(next.bot) : null,
  };
}

/** The failure text for the current stage: its last failed event, or the execution error. */
export function crewFailureDetail(snapshot: WorkflowFeatureSnapshot): string | null {
  const current = crewCurrentStep(snapshot);
  const failed = snapshot.recentEvents.findLast(
    (event) => event.kind === "failed" && event.stepId === current?.id,
  );
  return failed?.detail ?? snapshot.executionError ?? null;
}

/** Earlier stages a stage can be sent back to, nearest first. */
export function crewSendBackTargets(
  snapshot: WorkflowFeatureSnapshot,
  stepId: string,
): ReadonlyArray<{ readonly stepId: string; readonly label: string }> {
  const stages = workflowStageIds(snapshot.definition);
  const index = stages.indexOf(stepId);
  const ran = new Set(
    snapshot.steps.filter((step) => step.executionId !== null).map((step) => step.id),
  );
  return stages
    .slice(0, Math.max(index, 0))
    .filter((id) => ran.has(id))
    .reverse()
    .map((id) => ({ stepId: id, label: humanizeCrewId(id) }));
}

/** Routes a taken-over stage can hand on with, for Mark stage done. */
export function crewStageOutcomes(definition: WorkflowDefinition, stepId: string) {
  const step = definition.steps[stepId];
  return step?.type === "task" ? Object.keys(step.next) : [];
}

/** The workflow question the current stage waits on, if a person must answer it. */
export function crewOpenQuestion(snapshot: WorkflowFeatureSnapshot): string | null {
  const current = crewCurrentStep(snapshot);
  if (current?.status !== "needs-input") return null;
  const question = snapshot.recentEvents.findLast(
    (event) => event.kind === "question" && event.executionId === current.executionId,
  );
  return question?.detail ?? null;
}
