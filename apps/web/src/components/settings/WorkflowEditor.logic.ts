import type {
  BotTemplateConfig,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowStepReceives,
} from "@t3tools/contracts";

type TaskStep = Extract<WorkflowStep, { type: "task" }>;

/** Step and outcome ids share the server's id rule. */
export const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9_-]{0,79}$/;

/** `change_review` reads as "Change review". */
export function humanizeWorkflowId(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Task stages in the order a feature meets them: breadth-first from the start
 * stage, following each stage's routes in their listed order. Stages only
 * reachable through nothing come last, so an edit in progress never hides one.
 */
export function orderWorkflowStages(definition: WorkflowDefinition): string[] {
  const ordered: string[] = [];
  const queue = [definition.start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = definition.steps[id];
    if (step?.type !== "task") continue;
    ordered.push(id);
    queue.push(...Object.values(step.next));
  }
  for (const [id, step] of Object.entries(definition.steps)) {
    if (step.type === "task" && !seen.has(id)) ordered.push(id);
  }
  return ordered;
}

export function workflowEndStepId(definition: WorkflowDefinition): string {
  return Object.keys(definition.steps).find((id) => definition.steps[id]?.type === "end") ?? "end";
}

function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Files and diffs a stage may pick from: what the stages before it produce. */
export function earlierStageOutputs(definition: WorkflowDefinition, stepId: string) {
  const order = orderWorkflowStages(definition);
  const before = order.slice(0, Math.max(order.indexOf(stepId), 0));
  return {
    files: [
      ...new Set(
        before.flatMap((id) => {
          const step = definition.steps[id];
          return step?.type === "task" ? (step.outputs ?? []) : [];
        }),
      ),
    ],
    diffs: before,
  };
}

/** The "Gets …" line: what reaches a stage in its handoff besides the brief. */
export function describeStageInputs(definition: WorkflowDefinition, stepId: string): string {
  const step = definition.steps[stepId];
  if (step?.type !== "task") return "";
  if (!step.receives) return "Gets every earlier output and your notes";
  const parts = [
    ...step.receives.files,
    ...step.receives.diffs.map((id) => `the ${humanizeWorkflowId(id)} changes`),
  ];
  return parts.length === 0
    ? "Gets the brief and your notes"
    : `Gets ${joinWords([...parts, "your notes"])}`;
}

export type WorkflowRoleIssue = {
  readonly botId: string;
  readonly name: string;
  readonly reason: "changed" | "unavailable";
};

/**
 * A workflow pins each role's template revision, and the server refuses to
 * start a feature once a pinned role has been edited or turned off. This
 * moves every pin to the role's current revision and reports what moved, so
 * publishing brings the workflow up to date.
 */
export function refreshWorkflowRoles(
  definition: WorkflowDefinition,
  templates: readonly BotTemplateConfig[],
): { definition: WorkflowDefinition; issues: WorkflowRoleIssue[] } {
  const issues: WorkflowRoleIssue[] = [];
  const bots = { ...definition.bots };
  for (const [botId, bot] of Object.entries(definition.bots)) {
    if (bot.template.kind !== "template") continue;
    const templateId = bot.template.id;
    const template = templates.find((candidate) => candidate.id === templateId);
    if (!template || !template.enabled || !template.autoCreateForFeature) {
      issues.push({
        botId,
        name: template?.name ?? humanizeWorkflowId(botId),
        reason: "unavailable",
      });
    } else if (template.revision !== bot.template.revision) {
      issues.push({ botId, name: template.name, reason: "changed" });
      bots[botId] = { ...bot, template: { ...bot.template, revision: template.revision } };
    }
  }
  return { definition: issues.length > 0 ? { ...definition, bots } : definition, issues };
}

/** Structural equality for plain JSON values, ignoring key order. */
export function sameWorkflow(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        sameWorkflow(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
        ),
    )
  );
}

/** A stage can go once nothing starts at it or routes to it. */
export function canRemoveStage(definition: WorkflowDefinition, stepId: string): boolean {
  if (definition.start === stepId) return false;
  return Object.entries(definition.steps).every(
    ([id, step]) =>
      id === stepId || step.type !== "task" || !Object.values(step.next).includes(stepId),
  );
}

export function removeStage(definition: WorkflowDefinition, stepId: string): WorkflowDefinition {
  const steps = { ...definition.steps };
  delete steps[stepId];
  if (!definition.layout || !Object.hasOwn(definition.layout, stepId)) {
    return normalizeReceives({ ...definition, steps });
  }
  const { [stepId]: _removed, ...layout } = definition.layout;
  return normalizeReceives({ ...definition, steps, layout });
}

/** After stages or outputs change, later stages' picks only name what still exists. */
export function normalizeReceives(definition: WorkflowDefinition): WorkflowDefinition {
  return Object.entries(definition.steps).reduce(
    (current, [id, step]) =>
      step.type === "task" && step.receives
        ? updateTask(current, id, (task) => ({
            ...task,
            receives: keepReceivable(current, task.receives!),
          }))
        : current,
    definition,
  );
}

/** Drops picked files no stage produces any more and diffs of stages that are gone. */
export function keepReceivable(
  definition: WorkflowDefinition,
  receives: WorkflowStepReceives,
): WorkflowStepReceives {
  const produced = new Set(
    Object.values(definition.steps).flatMap((step) =>
      step.type === "task" ? (step.outputs ?? []) : [],
    ),
  );
  return {
    files: receives.files.filter((file) => produced.has(file)),
    diffs: receives.diffs.filter((id) => definition.steps[id]?.type === "task"),
  };
}

export function updateTask(
  definition: WorkflowDefinition,
  stepId: string,
  change: (step: TaskStep) => TaskStep,
): WorkflowDefinition {
  const step = definition.steps[stepId];
  if (step?.type !== "task") return definition;
  return { ...definition, steps: { ...definition.steps, [stepId]: change(step) } };
}

/**
 * The workflow's bot key for a role, adding one when the workflow does not
 * use that role yet. New roles answer to the workflow's Manager, like the
 * starter's roles do.
 */
export function ensureWorkflowRole(
  definition: WorkflowDefinition,
  template: BotTemplateConfig,
): { definition: WorkflowDefinition; botId: string } {
  const existing = Object.entries(definition.bots).find(
    ([, bot]) => bot.template.kind === "template" && bot.template.id === template.id,
  );
  if (existing) return { definition, botId: existing[0] };
  const base =
    template.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+|-+$/g, "")
      // Bot ids are at most 80 characters; leave room for a uniqueness suffix.
      .slice(0, 72)
      .replace(/-+$/, "") || "role";
  let botId = base;
  for (let suffix = 2; Object.hasOwn(definition.bots, botId); suffix++) botId = `${base}-${suffix}`;
  const supervisor =
    Object.entries(definition.bots).find(
      ([, bot]) => bot.template.kind === "existing-project-bot",
    )?.[0] ?? null;
  return {
    botId,
    definition: {
      ...definition,
      bots: {
        ...definition.bots,
        [botId]: {
          template: { kind: "template", id: template.id, revision: template.revision },
          supervisor,
        },
      },
    },
  };
}

/** Drops roles no stage uses and nobody answers to, so a removed role can't block publishing. */
export function pruneUnusedRoles(definition: WorkflowDefinition): WorkflowDefinition {
  const bots = { ...definition.bots };
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Object.keys(bots)) {
      const used =
        Object.values(definition.steps).some((step) => step.type === "task" && step.bot === id) ||
        Object.values(bots).some((bot) => bot.supervisor === id);
      if (!used) {
        delete bots[id];
        changed = true;
      }
    }
  }
  return Object.keys(bots).length === Object.keys(definition.bots).length
    ? definition
    : { ...definition, bots };
}

/**
 * Replaces a stage's outcome names. Kept outcomes keep their route and limit;
 * new ones route to the end until a route row says otherwise.
 */
export function setStageOutcomes(
  definition: WorkflowDefinition,
  stepId: string,
  outcomes: readonly string[],
): WorkflowDefinition {
  const end = workflowEndStepId(definition);
  return updateTask(definition, stepId, (step) => {
    const next = Object.fromEntries(
      outcomes.map((outcome) => [outcome, step.next[outcome] ?? end]),
    );
    const limits = Object.fromEntries(
      Object.entries(step.limits ?? {}).filter(([outcome]) => Object.hasOwn(next, outcome)),
    );
    const { limits: _limits, ...rest } = step;
    return Object.keys(limits).length > 0 ? { ...rest, next, limits } : { ...rest, next };
  });
}

export function setRouteLimit(
  definition: WorkflowDefinition,
  stepId: string,
  outcome: string,
  limit: number | null,
): WorkflowDefinition {
  return updateTask(definition, stepId, (step) => {
    const limits = { ...step.limits };
    if (limit === null) delete limits[outcome];
    else limits[outcome] = limit;
    const { limits: _limits, ...rest } = step;
    return Object.keys(limits).length > 0 ? { ...rest, limits } : rest;
  });
}

/** Splits a comma or newline list, trimming and dropping blanks and repeats. */
export function parseList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/** A workflow id from a name, unique among `taken`. */
export function workflowIdFromName(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "workflow";
  let id = base;
  for (let suffix = 2; taken.includes(id); suffix++) id = `${base}-${suffix}`;
  return id;
}
