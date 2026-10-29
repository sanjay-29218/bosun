import {
  CAPTAIN_BOT_ID,
  featureIssueRef,
  headquartersBotId,
  type CrewStageSummary,
  type EnvironmentId,
  type ProjectId,
  type FeatureBoardCard,
  type FeatureCardState,
  type WorkflowDefinition,
} from "@t3tools/contracts";

import type { EnvironmentThreadShell } from "./models.ts";

/**
 * Pure Features-board logic shared by web and mobile. Cards come from `features.board`;
 * plain threads that wait on you come from the thread shells every client already has.
 */
export interface EnvironmentFeatureCard extends FeatureBoardCard {
  readonly environmentId: EnvironmentId;
}

export const featureCardKey = (card: {
  readonly environmentId: EnvironmentId;
  readonly featureId: string;
}) => `${card.environmentId}:${card.featureId}`;

const isClosedState = (state: FeatureCardState) => state === "done" || state === "cancelled";

/**
 * A thread's part in its project's board signal: it changes when the thread starts, stops, or
 * starts waiting on you, never on streamed messages. Stage threads move cards, so a board
 * re-reads when the joined signal of its project's threads changes.
 */
export const threadBoardSignal = (
  shell: Pick<
    EnvironmentThreadShell,
    "id" | "runtime" | "latestRun" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
) =>
  `${shell.id}/${shell.runtime?.status ?? "-"}/${shell.latestRun?.status ?? "-"}/${shell.hasPendingApprovals ? 1 : 0}${shell.hasPendingUserInput ? 1 : 0}`;

// ── Phases ───────────────────────────────────────────────────────────

const FEATURE_PHASES = ["plan", "design", "build", "verify", "ship", "done"] as const;
export type FeaturePhase = (typeof FEATURE_PHASES)[number];

export const FEATURE_PHASE_LABELS: Record<FeaturePhase, string> = {
  plan: "Plan",
  design: "Design",
  build: "Build",
  verify: "Verify",
  ship: "Ship",
  done: "Done",
};

const PHASE_WORDS: ReadonlyArray<readonly [Exclude<FeaturePhase, "done">, RegExp]> = [
  ["ship", /^(ship|release|merge|deploy|publish|launch)/],
  ["verify", /^(verif|review|qa|test|check|audit)/],
  ["design", /^(design|spec|ux|ui|architect)/],
  ["plan", /^(plan|research|brief|scope|triage|discover)/],
  ["build", /^(build|implement|code|develop|fix)/],
];

/**
 * Workflows have no phase field, so a stage's phase is read from the words of its id, then
 * its role. Unrecognised stages count as Build, where most work happens.
 */
export function stagePhase(stepId: string, role: string): Exclude<FeaturePhase, "done"> {
  for (const text of [stepId, role]) {
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
      for (const [phase, pattern] of PHASE_WORDS) if (pattern.test(word)) return phase;
    }
  }
  return "build";
}

export function featurePhase(card: FeatureBoardCard): FeaturePhase {
  if (card.state === "done" || card.state === "cancelled") return "done";
  return card.stage ? stagePhase(card.stage.stepId, card.stage.role) : "plan";
}

export interface FeaturePhaseGroup<Card extends FeatureBoardCard = EnvironmentFeatureCard> {
  readonly phase: FeaturePhase;
  readonly cards: ReadonlyArray<Card>;
}

/** Every phase in order, each newest first; Done is ordered by when it finished. */
export function groupFeaturesByPhase<Card extends FeatureBoardCard>(
  cards: ReadonlyArray<Card>,
): ReadonlyArray<FeaturePhaseGroup<Card>> {
  const groups = new Map<FeaturePhase, Card[]>(FEATURE_PHASES.map((phase) => [phase, []]));
  for (const card of cards) groups.get(featurePhase(card))!.push(card);
  return FEATURE_PHASES.map((phase) => ({
    phase,
    cards: [...groups.get(phase)!].sort((a, b) => b.stateSince.localeCompare(a.stateSince)),
  }));
}

// ── Workflow toggle: one workflow's stages as columns ────────────────

export interface FeatureStageColumn<Card extends FeatureBoardCard = EnvironmentFeatureCard> {
  readonly stepId: string;
  /** Null for the Done column. */
  readonly role: string | null;
  readonly gate: boolean;
  /** Set when the stage exists only in an older version some cards still run. */
  readonly onlyInRevision: number | null;
  /** Cards held at this stage's gate. */
  readonly waiting: number;
  readonly cards: ReadonlyArray<Card>;
}

export interface FeatureStageLoop {
  readonly from: string;
  readonly to: string;
  readonly outcome: string;
  readonly limit: number | null;
}

export interface FeatureStageBoard<Card extends FeatureBoardCard = EnvironmentFeatureCard> {
  readonly columns: ReadonlyArray<FeatureStageColumn<Card>>;
  /** Routes back to an earlier stage, drawn as arcs. */
  readonly loops: ReadonlyArray<FeatureStageLoop>;
  /** Features on other workflows, by workflow name. */
  readonly hidden: ReadonlyArray<{ readonly name: string; readonly count: number }>;
}

export const DONE_COLUMN_ID = "done";

const taskStepIds = (definition: WorkflowDefinition) =>
  Object.keys(definition.steps).filter((id) => definition.steps[id]?.type === "task");

/**
 * Lays cards out under `definition`'s stages. A card on an older version sits under the stage
 * with the same id; a stage that no longer exists gets its own column after the others.
 */
export function buildFeatureStageBoard<Card extends FeatureBoardCard>(
  definition: WorkflowDefinition,
  cards: ReadonlyArray<Card>,
): FeatureStageBoard<Card> {
  const order = taskStepIds(definition);
  const byStage = new Map<string, Card[]>(order.map((id) => [id, []]));
  const removed = new Map<string, number>();
  const done: Card[] = [];
  const hidden = new Map<string, number>();
  for (const card of cards) {
    if (card.workflow.id !== definition.id) {
      hidden.set(card.workflow.name, (hidden.get(card.workflow.name) ?? 0) + 1);
      continue;
    }
    if (isClosedState(card.state)) {
      done.push(card);
      continue;
    }
    const stepId = card.stage?.stepId ?? order[0];
    if (stepId === undefined) continue;
    if (!byStage.has(stepId)) {
      byStage.set(stepId, []);
      removed.set(stepId, card.workflow.revision);
    }
    byStage.get(stepId)!.push(card);
  }
  const newestFirst = (list: Card[]) =>
    [...list].sort((a, b) => b.stateSince.localeCompare(a.stateSince));
  const column = (stepId: string): FeatureStageColumn<Card> => {
    const step = definition.steps[stepId];
    const stageCards = byStage.get(stepId) ?? [];
    return {
      stepId,
      role: step?.type === "task" ? step.role : (stageCards[0]?.stage?.role ?? null),
      gate: step?.type === "task" ? step.gate === true : false,
      onlyInRevision: removed.get(stepId) ?? null,
      waiting: stageCards.filter((card) => card.state === "approval").length,
      cards: newestFirst(stageCards),
    };
  };
  const loops: FeatureStageLoop[] = [];
  for (const [index, stepId] of order.entries()) {
    const step = definition.steps[stepId];
    if (step?.type !== "task") continue;
    for (const [outcome, target] of Object.entries(step.next)) {
      const targetIndex = order.indexOf(target);
      if (targetIndex < 0 || targetIndex > index) continue;
      loops.push({ from: stepId, to: target, outcome, limit: step.limits?.[outcome] ?? null });
    }
  }
  return {
    columns: [
      ...order.map(column),
      ...[...removed.keys()].map(column),
      {
        stepId: DONE_COLUMN_ID,
        role: null,
        gate: false,
        onlyInRevision: null,
        waiting: 0,
        cards: newestFirst(done),
      },
    ],
    loops,
    hidden: [...hidden].map(([name, count]) => ({ name, count })),
  };
}

/** The workflow most features in scope run, which the Workflow toggle opens on. */
export function mostUsedWorkflowId(cards: ReadonlyArray<FeatureBoardCard>): string | null {
  const counts = new Map<string, number>();
  for (const card of cards) counts.set(card.workflow.id, (counts.get(card.workflow.id) ?? 0) + 1);
  let best: string | null = null;
  for (const [id, count] of counts) if (best === null || count > counts.get(best)!) best = id;
  return best;
}

// ── Needs you ────────────────────────────────────────────────────────

const NEEDS_YOU_KINDS = ["approval", "problem", "question"] as const;
export type NeedsYouKind = (typeof NEEDS_YOU_KINDS)[number];

export const NEEDS_YOU_LABELS: Record<NeedsYouKind, string> = {
  approval: "Approvals",
  problem: "Problems",
  question: "Questions",
};

/** Approval, Input, Your call and Failed wait on you. Working, Queued and Paused never do. */
function needsYouKindForState(state: FeatureCardState): NeedsYouKind | null {
  switch (state) {
    case "approval":
      return "approval";
    case "input":
      return "question";
    case "failed":
    case "your-call":
      return "problem";
    default:
      return null;
  }
}

/** The shell fields Needs you reads. Stage threads carry `crew`; older servers omit it. */
export type NeedsYouShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "archivedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "updatedAt"
> & {
  readonly runtime: { readonly updatedAt: string } | null;
  readonly crew?: CrewStageSummary | null;
};

/** A thread waiting on you: a tool approval or question, or a current stage that needs you. */
export function threadNeedsYouKind(shell: NeedsYouShell): NeedsYouKind | null {
  if (shell.archivedAt !== null) return null;
  const stageKind = shell.crew?.current ? needsYouKindForState(shell.crew.state) : null;
  if (stageKind) return stageKind;
  if (shell.hasPendingApprovals) return "approval";
  if (shell.hasPendingUserInput) return "question";
  return null;
}

/** The key `countNeedsYouByBot` counts under: bots belong to one environment. */
export const botNeedsYouKey = (environmentId: EnvironmentId, botId: string) =>
  `${environmentId}:${botId}`;

/**
 * Threads waiting on you per bot, keyed by `botNeedsYouKey`, from the shells and project
 * shells every client already has. A project without a `botId` (an older server) is Captain's.
 */
export function countNeedsYouByBot(
  shells: ReadonlyArray<NeedsYouShell & { readonly projectId: ProjectId }>,
  projects: ReadonlyArray<BotOwnedProject>,
): ReadonlyMap<string, number> {
  const ownerKey = createThreadBotKeyResolver(projects);
  const counts = new Map<string, number>();
  for (const shell of shells) {
    if (threadNeedsYouKind(shell) === null) continue;
    const key = ownerKey(shell);
    if (key === undefined) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export interface BotOwnedProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly botId?: string | undefined;
}

/**
 * The `botNeedsYouKey` of the bot a thread works for, or undefined when its project isn't
 * loaded. A headquarters belongs to its bot, not to the project it lives in.
 */
export function createThreadBotKeyResolver(projects: ReadonlyArray<BotOwnedProject>) {
  const owners = new Map(
    projects.map((project) => [
      `${project.environmentId}:${project.id}`,
      project.botId ?? CAPTAIN_BOT_ID,
    ]),
  );
  return (shell: {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly projectId: ProjectId;
  }): string | undefined => {
    const botId =
      headquartersBotId(shell.id) ?? owners.get(`${shell.environmentId}:${shell.projectId}`);
    return botId === undefined ? undefined : botNeedsYouKey(shell.environmentId, botId);
  };
}

export type NeedsYouItem<
  Card extends EnvironmentFeatureCard = EnvironmentFeatureCard,
  Shell extends NeedsYouShell = EnvironmentThreadShell,
> =
  | {
      readonly type: "feature";
      readonly key: string;
      readonly kind: NeedsYouKind;
      readonly since: string;
      readonly card: Card;
    }
  | {
      readonly type: "thread";
      readonly key: string;
      readonly kind: NeedsYouKind;
      readonly since: string;
      readonly shell: Shell;
    };

export interface NeedsYouGroup<
  Card extends EnvironmentFeatureCard = EnvironmentFeatureCard,
  Shell extends NeedsYouShell = EnvironmentThreadShell,
> {
  readonly kind: NeedsYouKind;
  readonly items: ReadonlyArray<NeedsYouItem<Card, Shell>>;
}

const threadKey = (shell: { readonly environmentId: EnvironmentId; readonly id: string }) =>
  `${shell.environmentId}:${shell.id}`;

/**
 * Everything waiting on you, grouped by kind and oldest first. A feature card that waits
 * stands in for its own stage thread; every other waiting thread is listed as itself, so a
 * tool approval in a working stage still shows.
 */
export function collectNeedsYou<
  Card extends EnvironmentFeatureCard,
  Shell extends NeedsYouShell,
>(input: {
  readonly cards: ReadonlyArray<Card>;
  readonly shells: ReadonlyArray<Shell>;
}): ReadonlyArray<NeedsYouGroup<Card, Shell>> {
  const items: NeedsYouItem<Card, Shell>[] = [];
  const coveredThreads = new Set<string>();
  const coveredFeatures = new Set<string>();
  for (const card of input.cards) {
    const kind = needsYouKindForState(card.state);
    if (!kind) continue;
    if (card.threadId) coveredThreads.add(threadKey({ ...card, id: card.threadId }));
    coveredFeatures.add(featureCardKey(card));
    items.push({
      type: "feature",
      key: featureCardKey(card),
      kind,
      since: card.stateSince,
      card,
    });
  }
  for (const shell of input.shells) {
    if (coveredThreads.has(threadKey(shell))) continue;
    if (shell.crew && coveredFeatures.has(`${shell.environmentId}:${shell.crew.featureId}`))
      continue;
    const kind = threadNeedsYouKind(shell);
    if (!kind) continue;
    items.push({
      type: "thread",
      key: threadKey(shell),
      kind,
      since: shell.runtime?.updatedAt ?? shell.updatedAt,
      shell,
    });
  }
  return NEEDS_YOU_KINDS.map((kind) => ({
    kind,
    items: items
      .filter((item) => item.kind === kind)
      .sort((a, b) => a.since.localeCompare(b.since) || a.key.localeCompare(b.key)),
  })).filter((group) => group.items.length > 0);
}

/** The item ⌘⇧Y opens: the one that has waited longest, whatever its kind. */
export function oldestNeedsYouItem<
  Card extends EnvironmentFeatureCard,
  Shell extends NeedsYouShell,
>(groups: ReadonlyArray<NeedsYouGroup<Card, Shell>>): NeedsYouItem<Card, Shell> | null {
  let oldest: NeedsYouItem<Card, Shell> | null = null;
  for (const group of groups)
    for (const item of group.items) if (oldest === null || item.since < oldest.since) oldest = item;
  return oldest;
}

// ── Search ───────────────────────────────────────────────────────────

export interface FeatureSearch {
  readonly text: string;
  readonly workflows: ReadonlyArray<string>;
}

const workflowSlug = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Splits `workflow:slug` tokens from free text. */
export function parseFeatureSearch(query: string): FeatureSearch {
  const workflows: string[] = [];
  const words: string[] = [];
  for (const token of query.trim().split(/\s+/)) {
    if (!token) continue;
    const match = /^workflow:(.+)$/i.exec(token);
    if (match?.[1]) workflows.push(workflowSlug(match[1]));
    else words.push(token.toLowerCase());
  }
  return { text: words.join(" "), workflows };
}

/** `extra` carries text the card shows from elsewhere, such as its project and branch. */
export function matchesFeatureSearch(
  card: FeatureBoardCard,
  search: FeatureSearch,
  extra: ReadonlyArray<string | null | undefined> = [],
): boolean {
  if (
    search.workflows.length > 0 &&
    !search.workflows.some(
      (slug) =>
        slug === workflowSlug(card.workflow.id) || slug === workflowSlug(card.workflow.name),
    )
  ) {
    return false;
  }
  if (!search.text) return true;
  const haystack = [
    card.title,
    card.stage?.stepId,
    card.stage?.role,
    card.workflow.name,
    card.issue ? `${featureIssueRef(card.issue)} ${card.issue.title}` : null,
    card.issue?.milestone,
    ...extra,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return search.text.split(" ").every((word) => haystack.includes(word));
}

// ── Queue, drag and actions ──────────────────────────────────────────

/** 1-based place in each environment's stage queue, by when each feature was queued. */
export function featureQueuePositions(
  cards: ReadonlyArray<EnvironmentFeatureCard>,
): ReadonlyMap<string, number> {
  const positions = new Map<string, number>();
  const queued = cards
    .filter((card) => card.state === "queued" && card.queuedAt !== null)
    .sort((a, b) => a.queuedAt!.localeCompare(b.queuedAt!));
  const counts = new Map<EnvironmentId, number>();
  for (const card of queued) {
    const next = (counts.get(card.environmentId) ?? 0) + 1;
    counts.set(card.environmentId, next);
    positions.set(featureCardKey(card), next);
  }
  return positions;
}

/**
 * The only board moves: into Done cancels, out of Done reopens. Everything else is refused,
 * so a column never claims a state the feature isn't in.
 */
export function featureDropAction(
  card: FeatureBoardCard,
  target: "done" | "open",
): "cancel" | "reopen" | null {
  if (target === "done") return isClosedState(card.state) ? null : "cancel";
  return isClosedState(card.state) ? "reopen" : null;
}

export type FeatureCardActionId =
  | "start"
  | "approve"
  | "request-changes"
  | "answer"
  | "retry"
  | "take-over"
  | "mark-done"
  | "send-back"
  | "skip"
  | "accept-as-is"
  | "one-more-round"
  | "start-now"
  | "pause"
  | "resume"
  | "cancel"
  | "reopen";

/** What a card's menu offers in each state, in the stage ⋯ menu's order. */
export function featureCardActions(card: FeatureBoardCard): ReadonlyArray<FeatureCardActionId> {
  if (isClosedState(card.state)) return ["reopen"];
  if (!card.started) return ["start", "cancel"];
  // A taken-over stage waits for you to finish it by hand or hand it back to the crew.
  if (card.stage?.takenOver && card.state === "working")
    return ["mark-done", "retry", "send-back", "cancel"];
  switch (card.state) {
    case "working":
      return ["pause", "cancel"];
    case "queued":
      return ["start-now", "pause", "cancel"];
    case "approval":
      return ["approve", "request-changes", "cancel"];
    case "input":
      return ["answer", "cancel"];
    case "your-call":
      return ["accept-as-is", "one-more-round", "take-over", "cancel"];
    case "failed":
      return ["retry", "take-over", "send-back", "skip", "cancel"];
    case "paused":
      return ["resume", "cancel"];
  }
}

export const FEATURE_CARD_ACTION_LABELS: Record<FeatureCardActionId, string> = {
  start: "Start feature",
  approve: "Approve",
  "request-changes": "Request changes…",
  answer: "Answer…",
  retry: "Retry stage",
  "take-over": "Take over",
  "mark-done": "Mark done…",
  "send-back": "Send back to…",
  skip: "Skip stage",
  "accept-as-is": "Accept as is",
  "one-more-round": "One more round",
  "start-now": "Start now",
  pause: "Pause",
  resume: "Resume",
  cancel: "Cancel feature",
  reopen: "Reopen feature",
};

/**
 * Stages a feature can be sent back to, in workflow order: the server takes only a stage
 * this run completed or skipped, which a branching workflow may not have visited.
 */
export function sendBackTargets(
  definition: WorkflowDefinition,
  steps: ReadonlyArray<{ readonly id: string; readonly status: string }>,
  stepId: string,
): ReadonlyArray<string> {
  const finished = new Set(
    steps
      .filter((step) => step.status === "completed" || step.status === "skipped")
      .map((step) => step.id),
  );
  return taskStepIds(definition).filter((id) => id !== stepId && finished.has(id));
}

/** The routes out of a stage, which Mark done asks you to pick from. */
export function stageOutcomes(definition: WorkflowDefinition, stepId: string) {
  const step = definition.steps[stepId];
  return step?.type === "task" ? Object.keys(step.next) : [];
}

/** "Design" from "design", "Change review" from "change_review". */
export function stageLabel(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : id;
}

/** "1st", "2nd", "3rd", "4th"… for queue positions. */
export function ordinal(value: number): string {
  const tens = value % 100;
  if (tens >= 11 && tens <= 13) return `${value}th`;
  const suffix = ["th", "st", "nd", "rd"][value % 10] ?? "th";
  return `${value}${suffix}`;
}
