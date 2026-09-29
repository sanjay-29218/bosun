import type { WorkflowDefinition, WorkflowStep } from "@t3tools/contracts";

export class WorkflowValidationError extends Error {
  readonly _tag = "WorkflowValidationError";
}

const validName = (value: string, limit: number) =>
  value.trim().length > 0 && value.length <= limit;

/** Validates a saved definition and returns a stable dependency order. */
export const validateWorkflowDefinition = (
  definition: WorkflowDefinition,
): ReadonlyArray<WorkflowStep> => {
  if (!validName(definition.id, 128) || !validName(definition.name, 200)) {
    throw new WorkflowValidationError("Workflow ID and name are required and must be bounded");
  }
  if (!Number.isSafeInteger(definition.revision) || definition.revision < 1) {
    throw new WorkflowValidationError("Workflow revision must be a positive integer");
  }
  if (definition.steps.length < 1 || definition.steps.length > 64) {
    throw new WorkflowValidationError("Workflow must contain 1-64 steps");
  }

  const byId = new Map<string, WorkflowStep>();
  for (const step of definition.steps) {
    if (!/^[a-z][a-z0-9_-]{0,79}$/.test(step.id)) {
      throw new WorkflowValidationError(`Invalid step ID: ${step.id}`);
    }
    if (byId.has(step.id)) {
      throw new WorkflowValidationError(`Duplicate step ID: ${step.id}`);
    }
    if (step.kind === "bot" && !validName(step.templateId, 128)) {
      throw new WorkflowValidationError(`Bot step ${step.id} needs a template`);
    }
    if (
      step.kind === "decision" &&
      step.approver.kind === "bot" &&
      !validName(step.approver.templateId, 128)
    ) {
      throw new WorkflowValidationError(`Decision step ${step.id} needs an approver template`);
    }
    byId.set(step.id, step);
  }

  const ends = definition.steps.filter((step) => step.kind === "end");
  if (ends.length !== 1) {
    throw new WorkflowValidationError("Workflow needs exactly one end step");
  }
  const end = ends[0]!;
  const dependents = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const step of definition.steps) {
    if (new Set(step.dependsOn).size !== step.dependsOn.length) {
      throw new WorkflowValidationError(`Duplicate dependency in step ${step.id}`);
    }
    remaining.set(step.id, step.dependsOn.length);
    for (const dependency of step.dependsOn) {
      if (!byId.has(dependency)) {
        throw new WorkflowValidationError(`Unknown dependency ${dependency} in step ${step.id}`);
      }
      if (dependency === step.id) {
        throw new WorkflowValidationError(`Step ${step.id} depends on itself`);
      }
      if (dependency === end.id) {
        throw new WorkflowValidationError("Nothing can depend on the end step");
      }
      const children = dependents.get(dependency) ?? [];
      children.push(step.id);
      dependents.set(dependency, children);
    }
  }

  const ready = [...remaining]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const ordered: WorkflowStep[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const child of dependents.get(id) ?? []) {
      const count = remaining.get(child)! - 1;
      remaining.set(child, count);
      if (count === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }
  if (ordered.length !== definition.steps.length) {
    throw new WorkflowValidationError("Workflow contains a dependency cycle");
  }

  // Every step must contribute to the single explicit end, including parallel branches.
  const ancestors = new Set<string>();
  const visit = (id: string) => {
    if (ancestors.has(id)) return;
    ancestors.add(id);
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency);
  };
  visit(end.id);
  if (ancestors.size !== definition.steps.length) {
    throw new WorkflowValidationError("Every step must lead to the end step");
  }
  return ordered;
};

export const readyWorkflowSteps = (
  definition: WorkflowDefinition,
  completedStepIds: ReadonlySet<string>,
): ReadonlyArray<WorkflowStep> => {
  const ordered = validateWorkflowDefinition(definition);
  const knownIds = new Set(ordered.map((step) => step.id));
  for (const id of completedStepIds) {
    if (!knownIds.has(id)) {
      throw new WorkflowValidationError(`Unknown completed step: ${id}`);
    }
  }
  for (const step of ordered) {
    if (
      completedStepIds.has(step.id) &&
      step.dependsOn.some((dependency) => !completedStepIds.has(dependency))
    ) {
      throw new WorkflowValidationError(`Completed step ${step.id} has incomplete dependencies`);
    }
  }
  return ordered.filter(
    (step) =>
      !completedStepIds.has(step.id) &&
      step.dependsOn.every((dependency) => completedStepIds.has(dependency)),
  );
};
