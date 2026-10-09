import type { WorkflowDefinition } from "@t3tools/contracts";

export class WorkflowValidationError extends Error {
  readonly _tag = "WorkflowValidationError";
}

const validId = (value: string) => /^[a-z][a-z0-9_-]{0,79}$/.test(value);
const validName = (value: string, limit: number) =>
  value.trim().length > 0 && value.length <= limit;
const intBetween = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

/** Validates published bot assignments and the single-path outcome graph. */
export const validateWorkflowDefinition = (definition: WorkflowDefinition): void => {
  if (!validName(definition.id, 128) || !validName(definition.name, 200)) {
    throw new WorkflowValidationError("Workflow ID and name are required and must be bounded");
  }
  if (
    definition.schemaVersion !== 1 ||
    !Number.isSafeInteger(definition.revision) ||
    definition.revision < 1
  ) {
    throw new WorkflowValidationError("Invalid workflow version");
  }
  const botIds = Object.keys(definition.bots);
  const stepIds = Object.keys(definition.steps);
  if (botIds.length < 1 || botIds.length > 32 || stepIds.length < 2 || stepIds.length > 64) {
    throw new WorkflowValidationError("Workflow needs 1-32 bots and 2-64 steps");
  }
  const { maxAttemptsPerExecution, maxStepExecutions, retries } = definition.defaults;
  if (
    (maxAttemptsPerExecution !== undefined && !intBetween(maxAttemptsPerExecution, 1, 10)) ||
    !intBetween(maxStepExecutions, 1, 500) ||
    (retries !== undefined && !intBetween(retries, 0, 10))
  ) {
    throw new WorkflowValidationError("Invalid workflow execution limits");
  }
  for (const [id, bot] of Object.entries(definition.bots)) {
    if (!validId(id) || !validName(bot.template.id, 128)) {
      throw new WorkflowValidationError(`Invalid workflow bot: ${id}`);
    }
    if (
      bot.template.kind === "template" &&
      (!Number.isSafeInteger(bot.template.revision) || bot.template.revision < 1)
    ) {
      throw new WorkflowValidationError(`Invalid template revision for ${id}`);
    }
    if (bot.supervisor !== null && !Object.hasOwn(definition.bots, bot.supervisor)) {
      throw new WorkflowValidationError(`Unknown supervisor for ${id}`);
    }
    const visited = new Set<string>([id]);
    let supervisor = bot.supervisor;
    while (supervisor !== null) {
      if (visited.has(supervisor)) throw new WorkflowValidationError("Supervisor cycle");
      visited.add(supervisor);
      supervisor = definition.bots[supervisor]?.supervisor ?? null;
    }
  }
  if (!validId(definition.start) || definition.steps[definition.start]?.type !== "task") {
    throw new WorkflowValidationError("Workflow start must be a task");
  }
  const ends = stepIds.filter((id) => definition.steps[id]?.type === "end");
  if (ends.length !== 1) throw new WorkflowValidationError("Workflow needs exactly one end step");
  const endId = ends[0]!;
  for (const [id, step] of Object.entries(definition.steps)) {
    if (!validId(id)) throw new WorkflowValidationError(`Invalid step ID: ${id}`);
    if (step.type === "end") continue;
    if (!Object.hasOwn(definition.bots, step.bot) || !validName(step.task, 8_000)) {
      throw new WorkflowValidationError(`Invalid task or bot in step ${id}`);
    }
    const routes = Object.entries(step.next);
    if (routes.length < 1 || routes.length > 8) {
      throw new WorkflowValidationError(`Step ${id} needs 1-8 outcome routes`);
    }
    for (const [outcome, target] of routes) {
      if (!validId(outcome) || !Object.hasOwn(definition.steps, target)) {
        throw new WorkflowValidationError(`Invalid outcome route from ${id}`);
      }
    }
    for (const [outcome, limit] of Object.entries(step.limits ?? {})) {
      if (!Object.hasOwn(step.next, outcome) || !intBetween(limit, 1, 20)) {
        throw new WorkflowValidationError(`Invalid route limit from ${id}`);
      }
    }
  }
  const reachable = new Set<string>();
  const visit = (id: string) => {
    if (reachable.has(id)) return;
    reachable.add(id);
    const step = definition.steps[id]!;
    if (step.type === "task") Object.values(step.next).forEach(visit);
  };
  visit(definition.start);
  if (reachable.size !== stepIds.length) {
    throw new WorkflowValidationError("Every step must be reachable from start");
  }
  const leadsToEnd = new Set<string>([endId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, step] of Object.entries(definition.steps)) {
      if (
        step.type === "task" &&
        !leadsToEnd.has(id) &&
        Object.values(step.next).some((target) => leadsToEnd.has(target))
      ) {
        leadsToEnd.add(id);
        changed = true;
      }
    }
  }
  if (leadsToEnd.size !== stepIds.length) {
    throw new WorkflowValidationError("Every step needs a path to the end");
  }
};

export const nextWorkflowStep = (
  definition: WorkflowDefinition,
  stepId: string,
  outcome: string,
) => {
  const step = definition.steps[stepId];
  if (step?.type !== "task" || !Object.hasOwn(step.next, outcome)) {
    throw new WorkflowValidationError("Outcome has no transition");
  }
  return step.next[outcome]!;
};
