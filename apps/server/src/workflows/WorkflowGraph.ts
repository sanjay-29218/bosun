import type { WorkflowDefinition } from "@t3tools/contracts";

export class WorkflowValidationError extends Error {
  readonly _tag = "WorkflowValidationError";
}

const validId = (value: string) => /^[a-z][a-z0-9_-]{0,79}$/.test(value);
const validName = (value: string, limit: number) =>
  value.trim().length > 0 && value.length <= limit;
const intBetween = (value: number, min: number, max: number) =>
  Number.isSafeInteger(value) && value >= min && value <= max;

// Output files live inside the stage's worktree: relative, normalized, no parent segments.
const validOutputPath = (value: string) =>
  validName(value, 200) &&
  value === value.trim() &&
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

/** Validates published role assignments and the single-path outcome graph. */
export const validateWorkflowDefinition = (definition: WorkflowDefinition): void => {
  if (!validName(definition.id, 128) || !validName(definition.name, 200)) {
    throw new WorkflowValidationError("Workflow ID and name are required and must be bounded");
  }
  if (
    definition.schemaVersion !== 2 ||
    !Number.isSafeInteger(definition.revision) ||
    definition.revision < 1
  ) {
    throw new WorkflowValidationError("Invalid workflow version");
  }
  const roleIds = Object.keys(definition.roles);
  const stepIds = Object.keys(definition.steps);
  if (roleIds.length < 1 || roleIds.length > 32 || stepIds.length < 2 || stepIds.length > 64) {
    throw new WorkflowValidationError("Workflow needs 1-32 roles and 2-64 steps");
  }
  const { maxAttemptsPerExecution, maxStepExecutions, retries } = definition.defaults;
  if (
    (maxAttemptsPerExecution !== undefined && !intBetween(maxAttemptsPerExecution, 1, 10)) ||
    !intBetween(maxStepExecutions, 1, 500) ||
    (retries !== undefined && !intBetween(retries, 0, 10))
  ) {
    throw new WorkflowValidationError("Invalid workflow execution limits");
  }
  for (const [id, role] of Object.entries(definition.roles)) {
    if (!validId(id) || !validName(role.roleId, 128)) {
      throw new WorkflowValidationError(`Invalid workflow role: ${id}`);
    }
    if (!Number.isSafeInteger(role.roleRevision) || role.roleRevision < 1) {
      throw new WorkflowValidationError(`Invalid role revision for ${id}`);
    }
    if (role.supervisor !== null && !Object.hasOwn(definition.roles, role.supervisor)) {
      throw new WorkflowValidationError(`Unknown supervisor for ${id}`);
    }
    const visited = new Set<string>([id]);
    let supervisor = role.supervisor;
    while (supervisor !== null) {
      if (visited.has(supervisor)) throw new WorkflowValidationError("Supervisor cycle");
      visited.add(supervisor);
      supervisor = definition.roles[supervisor]?.supervisor ?? null;
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
    if (!Object.hasOwn(definition.roles, step.role) || !validName(step.task, 8_000)) {
      throw new WorkflowValidationError(`Invalid task or role in step ${id}`);
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
    if (
      (step.outputs !== undefined &&
        (step.outputs.length > 16 ||
          new Set(step.outputs).size !== step.outputs.length ||
          !step.outputs.every(validOutputPath))) ||
      (step.scope !== undefined && !validName(step.scope, 200))
    ) {
      throw new WorkflowValidationError(`Invalid outputs or scope in step ${id}`);
    }
  }
  const produced = new Set(
    Object.values(definition.steps).flatMap((step) =>
      step.type === "task" ? (step.outputs ?? []) : [],
    ),
  );
  for (const [id, step] of Object.entries(definition.steps)) {
    if (step.type !== "task" || step.receives === undefined) continue;
    const { files, diffs } = step.receives;
    if (
      files.length > 32 ||
      diffs.length > 32 ||
      !files.every((file) => produced.has(file)) ||
      !diffs.every((source) => definition.steps[source]?.type === "task")
    ) {
      throw new WorkflowValidationError(`Step ${id} receives an output no step produces`);
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
