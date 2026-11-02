import type {
  OrchestrationV2UserInputQuestion,
  ThreadId,
  WorkflowFeatureSnapshot,
  WorkflowStepSnapshot,
} from "@t3tools/contracts";

/**
 * A workflow stage's decisions: which actions the feature accepts now, and the question a
 * waiting stage asks. The server opens that question on the stage thread and runs the action an
 * answer names; clients use the same rules so their menus only offer what the server accepts.
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

export type CrewAction =
  | "answer"
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

/** Labels and one-line consequences, shared by the banner menus, Crew tab and palette. */
export const CREW_ACTION_COPY: Record<
  CrewAction,
  { readonly label: string; readonly description: string }
> = {
  answer: { label: "Answer", description: "Send your reply to the stage, which carries on" },
  approve: { label: "Approve", description: "Hand this stage's result to the next stage" },
  "request-changes": {
    label: "Request changes",
    description: "Run the stage again with your note from the composer",
  },
  retry: { label: "Retry stage", description: "Runs the stage again with the error attached" },
  "take-over": {
    label: "Take over",
    description: "You drive this thread, then choose Mark stage done",
  },
  "mark-done": { label: "Mark stage done", description: "Hand your result to the next stage" },
  "send-back": {
    label: "Send back to…",
    description: "An earlier stage reruns with the error attached",
  },
  skip: { label: "Skip stage", description: "Continue without this stage's changes" },
  "accept-as-is": { label: "Accept as is", description: "Move on with the current result" },
  "one-more-round": { label: "One more round", description: "Allow the loop to run once more" },
  pause: { label: "Pause feature", description: "Current work may finish; the next stage waits" },
  resume: { label: "Resume feature", description: "Continue from where it paused" },
  cancel: {
    label: "Stop feature",
    description: "Keeps the branch and threads. Reopen it later.",
  },
  reopen: { label: "Reopen feature", description: "Continue a stopped or finished feature" },
  "start-now": { label: "Start now", description: "Run the queued stage past the agent limit" },
};

function activeStep(snapshot: WorkflowFeatureSnapshot): WorkflowStepSnapshot | null {
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
  if (statusIn(step, "needs-input")) actions.push("answer");
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
  | { readonly kind: "input"; readonly stepId: string; readonly question: string | null }
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
    case "needs-input":
      return {
        kind: "input",
        stepId: step.id,
        question: lastEvent(snapshot, step.id, "question")?.detail ?? null,
      };
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

/** An action a stage's question answers with, and what goes with it. */
export interface CrewStageChoice {
  readonly action: CrewAction;
  readonly stepId?: string;
  readonly outcome?: string;
  readonly text?: string;
}

/** What a typed reply does: answers a question, requests changes, or marks a take-over done. */
const REPLY: Partial<Record<CrewStagePrompt["kind"], { action: CrewAction; hint: string }>> = {
  input: { action: "answer", hint: "Reply to answer." },
  gate: { action: "request-changes", hint: "Reply to request changes." },
  "taken-over": { action: "mark-done", hint: "Reply with a summary to mark it done." },
};

const PRIMARY: Record<CrewStagePrompt["kind"], ReadonlyArray<CrewAction>> = {
  input: [],
  gate: ["approve"],
  failure: ["retry", "skip"],
  "your-call": ["accept-as-is", "one-more-round"],
  "taken-over": ["retry"],
};

// Option values carry this prefix, so a typed reply can never read as an option.
const VALUE_PREFIX = "crew:";

const option = (action: CrewAction, target?: string, label?: string) => ({
  label: label ?? CREW_ACTION_COPY[action].label,
  description: CREW_ACTION_COPY[action].description,
  value: `${VALUE_PREFIX}${action}${target === undefined ? "" : `:${target}`}`,
});

/**
 * A stage's decision as a question for the composer's question panel. Each option runs an
 * action the server allows now; a typed reply requests changes at a gate, or marks a stage you
 * took over done with it as the summary.
 */
export function crewStageQuestion(input: {
  readonly prompt: CrewStagePrompt;
  readonly actions: ReadonlyArray<CrewAction>;
  readonly sendBackTargets: ReadonlyArray<string>;
}): OrchestrationV2UserInputQuestion & { readonly multiSelect: boolean } {
  const { prompt, actions } = input;
  const stage = formatStageName(prompt.stepId);
  const has = (action: CrewAction) => actions.includes(action);
  const reply = REPLY[prompt.kind];
  const [header, question] =
    prompt.kind === "input"
      ? [`${stage} asks`, prompt.question ?? `The ${stage.toLowerCase()} stage has a question.`]
      : prompt.kind === "gate"
        ? [`${stage} approval`, prompt.summary ?? `Approve the ${stage.toLowerCase()} stage?`]
        : prompt.kind === "failure"
          ? [`${stage} failed · attempt ${prompt.attempt}`, prompt.error ?? "The stage failed."]
          : prompt.kind === "your-call"
            ? [
                `${stage} reached its ${prompt.reason === "loop-limit" ? "loop" : "stage"} limit`,
                `Next would be ${formatStageName(prompt.target)}. It's your call.`,
              ]
            : [`You're driving ${stage}`, "Mark it done to hand your result to the next stage."];
  return {
    id: "crew-stage",
    header,
    question: reply ? `${question} ${reply.hint}` : question,
    options: [
      ...(prompt.kind === "taken-over" && has("mark-done")
        ? prompt.outcomes.map((outcome) =>
            option(
              "mark-done",
              outcome,
              prompt.outcomes.length > 1 ? `Mark done: ${formatStageName(outcome)}` : undefined,
            ),
          )
        : []),
      ...PRIMARY[prompt.kind].filter(has).map((action) => option(action)),
      ...(has("send-back")
        ? input.sendBackTargets.map((stepId) =>
            option("send-back", stepId, `Send back to ${formatStageName(stepId)}`),
          )
        : []),
      ...(["take-over", "cancel"] as const).filter(has).map((action) => option(action)),
    ],
    multiSelect: false,
    allowCustomAnswer: reply !== undefined && has(reply.action),
  };
}

/** What an answer to `crewStageQuestion` runs: a picked option, or a typed reply. */
export function crewStageAnswer(prompt: CrewStagePrompt, answer: string): CrewStageChoice | null {
  if (answer.startsWith(VALUE_PREFIX)) {
    const [action, target] = answer.slice(VALUE_PREFIX.length).split(":", 2) as [
      CrewAction,
      string | undefined,
    ];
    if (action === "send-back") return { action, stepId: target ?? "" };
    if (action === "mark-done") return { action, outcome: target ?? "" };
    return { action };
  }
  const reply = REPLY[prompt.kind];
  const text = answer.trim();
  if (!reply || !text) return null;
  return prompt.kind === "taken-over"
    ? { action: reply.action, text, outcome: prompt.outcomes[0] ?? "" }
    : { action: reply.action, text };
}
