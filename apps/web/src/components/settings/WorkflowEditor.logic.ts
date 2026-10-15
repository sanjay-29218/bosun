import {
  PROJECT_MANAGER_ROLE_ID,
  type RoleConfig,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowStepReceives,
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
  readonly slot: string;
  readonly name: string;
  readonly reason: "changed" | "unavailable";
};

/**
 * A workflow pins each role's revision, and the server refuses to start a
 * feature once a pinned role has been edited or turned off. This moves every
 * pin to the role's current revision and reports what moved, so publishing
 * brings the workflow up to date. The project manager slot binds to the
 * project's manager, so it is left alone.
 */
export function refreshWorkflowRoles(
  definition: WorkflowDefinition,
  roles: readonly RoleConfig[],
): { definition: WorkflowDefinition; issues: WorkflowRoleIssue[] } {
  const issues: WorkflowRoleIssue[] = [];
  const slots = { ...definition.roles };
  for (const [slot, entry] of Object.entries(definition.roles)) {
    if (entry.roleId === PROJECT_MANAGER_ROLE_ID) continue;
    const role = roles.find((candidate) => candidate.id === entry.roleId);
    if (!role || !role.enabled || !role.autoCreateForFeature) {
      issues.push({
        slot,
        name: role?.name ?? humanizeWorkflowId(slot),
        reason: "unavailable",
      });
    } else if (role.revision !== entry.roleRevision) {
      issues.push({ slot, name: role.name, reason: "changed" });
      slots[slot] = { ...entry, roleRevision: role.revision };
    }
  }
  return {
    definition: issues.length > 0 ? { ...definition, roles: slots } : definition,
    issues,
  };
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
 * The workflow's slot for a role, adding one when the workflow does not use
 * that role yet. New slots answer to the workflow's project manager, like the
 * starter's roles do.
 */
export function ensureWorkflowRole(
  definition: WorkflowDefinition,
  role: RoleConfig,
): { definition: WorkflowDefinition; slot: string } {
  const existing = Object.entries(definition.roles).find(([, entry]) => entry.roleId === role.id);
  if (existing) return { definition, slot: existing[0] };
  const base =
    role.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+|-+$/g, "")
      // Slot ids are at most 80 characters; leave room for a uniqueness suffix.
      .slice(0, 72)
      .replace(/-+$/, "") || "role";
  let slot = base;
  for (let suffix = 2; Object.hasOwn(definition.roles, slot); suffix++) slot = `${base}-${suffix}`;
  const supervisor =
    Object.entries(definition.roles).find(
      ([, entry]) => entry.roleId === PROJECT_MANAGER_ROLE_ID,
    )?.[0] ?? null;
  return {
    slot,
    definition: {
      ...definition,
      roles: {
        ...definition.roles,
        [slot]: { roleId: role.id, roleRevision: role.revision, supervisor },
      },
    },
  };
}

/**
 * A stage run by `role`, dropped on the canvas at `position`. It routes `done` to Finish and
 * nothing routes to it yet; connecting an outcome to it puts it in the flow. Its task is
 * empty, so publishing waits until the stage is described.
 */
export function addStageForRole(
  definition: WorkflowDefinition,
  role: RoleConfig,
  position: { readonly x: number; readonly y: number },
): { definition: WorkflowDefinition; stepId: string } {
  const { definition: withRole, slot } = ensureWorkflowRole(definition, role);
  const taken = Object.keys(withRole.steps);
  const named = workflowIdFromName(role.name, taken);
  const stepId = WORKFLOW_ID_PATTERN.test(named) ? named : workflowIdFromName("stage", taken);
  return {
    stepId,
    definition: {
      ...withRole,
      steps: {
        ...withRole.steps,
        [stepId]: {
          type: "task",
          role: slot,
          task: "",
          next: { done: workflowEndStepId(withRole) },
        },
      },
      layout: { ...withRole.layout, [stepId]: { x: position.x, y: position.y } },
    },
  };
}

/** Roles a stage can run as: enabled roles that can run stages, and the project manager. */
export function stageCapableRoles(roles: readonly RoleConfig[]): RoleConfig[] {
  return roles.filter(
    (role) => role.enabled && (role.autoCreateForFeature || role.id === PROJECT_MANAGER_ROLE_ID),
  );
}

/** Drops roles no stage uses and nobody answers to, so a removed role can't block publishing. */
export function pruneUnusedRoles(definition: WorkflowDefinition): WorkflowDefinition {
  const slots = { ...definition.roles };
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of Object.keys(slots)) {
      const used =
        Object.values(definition.steps).some((step) => step.type === "task" && step.role === id) ||
        Object.values(slots).some((entry) => entry.supervisor === id);
      if (!used) {
        delete slots[id];
        changed = true;
      }
    }
  }
  return Object.keys(slots).length === Object.keys(definition.roles).length
    ? definition
    : { ...definition, roles: slots };
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
