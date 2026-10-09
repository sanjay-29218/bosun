import type {
  ThreadId,
  WorkflowDefinition,
  WorkflowStageHandoff,
  WorkflowStageNote,
  WorkflowStageOutput,
  WorkflowStepEvent,
} from "@t3tools/contracts";

import type { StageThreadDiff } from "./WorkflowWorkspace.ts";

/** The newest completed execution of each step, in completion order. */
export interface StageResult {
  readonly stepId: string;
  readonly executionId: string;
  readonly version: number;
  readonly botRunId: string | null;
}

export const latestStageResults = (
  events: ReadonlyArray<WorkflowStepEvent>,
): ReadonlyArray<StageResult> => {
  const latest = new Map<string, StageResult>();
  const versions = new Map<string, number>();
  for (const event of events) {
    if (event.kind !== "completed" || event.executionId === null) continue;
    const version = (versions.get(event.stepId) ?? 0) + 1;
    versions.set(event.stepId, version);
    const start = events.findLast(
      (candidate) => candidate.kind === "started" && candidate.executionId === event.executionId,
    );
    latest.delete(event.stepId);
    latest.set(event.stepId, {
      stepId: event.stepId,
      executionId: event.executionId,
      version,
      botRunId: start?.botRunId ?? null,
    });
  }
  return [...latest.values()];
};

/** Files a step declares and the diff its thread made, newest version of each. */
export const collectStageOutputs = (
  definition: WorkflowDefinition,
  results: ReadonlyArray<StageResult>,
  threads: ReadonlyMap<string, ThreadId>,
  diffs: ReadonlyMap<ThreadId, StageThreadDiff>,
): ReadonlyArray<WorkflowStageOutput> =>
  results.flatMap((result) => {
    const step = definition.steps[result.stepId];
    const threadId = result.botRunId ? (threads.get(result.botRunId) ?? null) : null;
    const files: ReadonlyArray<WorkflowStageOutput> =
      step?.type === "task"
        ? (step.outputs ?? []).map((path) => ({
            kind: "file" as const,
            path,
            stepId: result.stepId,
            version: result.version,
            threadId,
          }))
        : [];
    const diff = threadId ? diffs.get(threadId) : undefined;
    return diff && diff.fileCount > 0
      ? [
          ...files,
          {
            kind: "diff" as const,
            stepId: result.stepId,
            version: result.version,
            threadId: threadId!,
            ...diff,
          },
        ]
      : files;
  });

/** Applies a step's `receives`; without one it gets every earlier output. */
export const selectReceived = (
  definition: WorkflowDefinition,
  stepId: string,
  outputs: ReadonlyArray<WorkflowStageOutput>,
): ReadonlyArray<WorkflowStageOutput> => {
  const step = definition.steps[stepId];
  const receives = step?.type === "task" ? step.receives : undefined;
  if (!receives) return outputs;
  return outputs.filter((output) =>
    output.kind === "file"
      ? receives.files.includes(output.path)
      : receives.diffs.includes(output.stepId),
  );
};

/**
 * The completion that routed work here, plus people's notes on decisions since then.
 * Answers to a stage's own questions stay in that stage's thread.
 */
export const collectNotes = (
  events: ReadonlyArray<WorkflowStepEvent>,
  executionId: string,
): {
  readonly from: WorkflowStageHandoff["from"];
  readonly notes: ReadonlyArray<WorkflowStageNote>;
} => {
  const firstStart = events.findIndex(
    (event) => event.kind === "started" && event.executionId === executionId,
  );
  const before = firstStart === -1 ? events : events.slice(0, firstStart);
  const routedIndex = before.findLastIndex((event) => event.kind === "completed");
  const routed = routedIndex === -1 ? null : before[routedIndex]!;
  const notes: Array<WorkflowStageNote> = [];
  if (routed?.detail) {
    notes.push({
      stepId: routed.stepId,
      kind: "routed",
      outcome: routed.outcome,
      text: routed.detail,
      actorId: routed.actorId,
      occurredAt: routed.occurredAt,
    });
  }
  events.forEach((event, index) => {
    // Request changes and Send back are people's decisions too; their note travels with the rerun.
    const decided =
      event.sourceKind === "decision" ||
      event.kind === "changes-requested" ||
      event.kind === "sent-back";
    if (
      !decided ||
      event.kind === "answered" ||
      !event.detail?.trim() ||
      !(
        index > routedIndex ||
        (routed !== null && event.executionId === routed.executionId) ||
        event.executionId === executionId
      )
    )
      return;
    notes.push({
      stepId: event.stepId,
      kind: "decision",
      outcome: event.outcome,
      text: event.detail,
      actorId: event.actorId,
      occurredAt: event.occurredAt,
    });
  });
  return {
    from: routed?.outcome != null ? { stepId: routed.stepId, outcome: routed.outcome } : null,
    notes,
  };
};

/** The last failure of this execution, which a retry attempt starts from. */
export const previousFailure = (
  events: ReadonlyArray<WorkflowStepEvent>,
  executionId: string,
  attempt: number,
): WorkflowStageHandoff["retry"] => {
  if (attempt <= 1) return null;
  const failed = events.findLast(
    (event) => event.kind === "failed" && event.executionId === executionId,
  );
  return { previousError: failed?.detail ?? "The previous attempt did not finish" };
};

// BotHandoffService bounds delegated text. The task carries only the step's task.
const CONTEXT_LIMIT = 4_000;
const MAX_NOTE = 1_500;
const MORE = "Some of this handoff was shortened. Call bots_stage_handoff for the full record.";

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

const describeOutput = (output: WorkflowStageOutput) =>
  output.kind === "file"
    ? `- ${output.path} v${output.version}, from ${output.stepId}${
        output.exists === false ? " (missing from the worktree)" : ""
      }`
    : `- Changes from ${output.stepId} v${output.version}: +${output.additions} -${output.deletions} in ${output.fileCount} files (git diff ${output.fromRef} ${output.toRef})`;

/**
 * Renders the stage prompt from the handoff record alone. The text is deterministic,
 * so re-delegating after a restart matches the persisted request. When the record
 * does not fit, outputs, then notes, then the brief are shortened, and the bot is
 * pointed at bots_stage_handoff.
 */
export const renderStageHandoff = (
  record: WorkflowStageHandoff,
): { readonly taskText: string; readonly contextText: string } => {
  const workspace = record.workspace.cwd
    ? `Worktree: ${record.workspace.cwd}${
        record.workspace.branch ? ` on ${record.workspace.branch}` : ""
      }${record.workspace.commit ? ` @ ${record.workspace.commit.slice(0, 12)}` : ""}`
    : "";
  const render = (outputs: number, notes: string, brief: string, more: boolean) =>
    [
      `Workflow ${record.workflow.name} v${record.workflow.revision}, stage ${record.stepId}${
        record.attempt > 1 ? `, attempt ${record.attempt}` : ""
      }.`,
      record.from
        ? `Handed off from ${record.from.stepId} (${record.from.outcome}).`
        : "This is the first stage.",
      record.scope ? `Scope: ${record.scope}` : "",
      workspace,
      record.outputs.length > 0
        ? [
            "You receive these outputs. Nothing else is carried between stages:",
            ...record.outputs.slice(0, outputs).map(describeOutput),
          ].join("\n")
        : "You receive no earlier outputs.",
      record.produces.length > 0 ? `Write: ${record.produces.join(", ")}` : "",
      record.retry
        ? `The previous attempt failed: ${clip(record.retry.previousError, MAX_NOTE)}`
        : "",
      notes ? `Notes:\n${notes}` : "",
      brief ? `Brief:\n${brief}` : "",
      more ? MORE : "",
      `Report with bots_respond: completed, summary containing ONLY JSON {"outcome":"<one of: ${record.outcomes.join(", ")}>","summary":"<result and evidence>"}.`,
      "Use bots_ask for questions. A final chat message does not complete this step.",
    ]
      .filter(Boolean)
      .join("\n\n");

  const fullNotes = record.notes
    .map((note) =>
      note.kind === "routed"
        ? `- ${note.stepId} (${note.outcome ?? "completed"}): ${note.text}`
        : `- Note from ${note.actorId} on ${note.stepId}: ${note.text}`,
    )
    .join("\n");
  const brief = record.brief.trim();
  const full = render(record.outputs.length, fullNotes, brief, false);
  if (full.length <= CONTEXT_LIMIT) return { taskText: record.task, contextText: full };

  // Reserve the pointer line, then give each part what is left in priority order.
  let outputs = record.outputs.length;
  while (outputs > 0 && render(outputs, "", "", true).length > CONTEXT_LIMIT) outputs--;
  const notesRoom = CONTEXT_LIMIT - render(outputs, "", "", true).length - "\n\nNotes:\n".length;
  const notes = notesRoom > 40 ? clip(fullNotes, notesRoom) : "";
  const briefRoom = CONTEXT_LIMIT - render(outputs, notes, "", true).length - "\n\nBrief:\n".length;
  return {
    taskText: record.task,
    contextText: render(outputs, notes, briefRoom > 40 ? clip(brief, briefRoom) : "", true),
  };
};
