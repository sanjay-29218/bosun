import {
  PROJECT_MANAGER_ROLE_ID,
  type EnvironmentId,
  type RoleConfig,
  type WorkflowDefinition,
} from "@t3tools/contracts";

import { formatStageName } from "../crewStage.ts";

/** Workflows and roles are environment-local, so their ids only mean something with the environment. */
const libraryItemKey = (environmentId: EnvironmentId, id: string) => `${environmentId}:${id}`;

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

/** "Plan → Design → Build → Review". */
export const workflowStagePath = (definition: WorkflowDefinition) =>
  orderWorkflowStages(definition).map(formatStageName).join(" → ");

/** Why a role won't run new stages, or null when it will. */
export function roleAvailabilityNote(role: RoleConfig): string | null {
  if (!role.enabled) return "Off";
  // The project manager joins workflows as the project's own manager, not as a stage role.
  if (!role.autoCreateForFeature && role.id !== PROJECT_MANAGER_ROLE_ID) {
    return "Not available to workflow stages";
  }
  return null;
}

export interface EnvironmentLibrary {
  readonly environmentId: EnvironmentId;
  readonly workflows: ReadonlyArray<WorkflowDefinition>;
  readonly roles: ReadonlyArray<RoleConfig>;
}

export interface LibraryWorkflowEntry {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly workflow: WorkflowDefinition;
  readonly stagePath: string;
}

export interface LibraryRoleEntry {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly role: RoleConfig;
}

const byName = (left: { readonly name: string }, right: { readonly name: string }) =>
  left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

/**
 * The Library's two lists across environments, each sorted by name. The same workflow on two
 * environments sits side by side, in environment order.
 */
export function libraryEntries(environments: ReadonlyArray<EnvironmentLibrary>): {
  readonly workflows: ReadonlyArray<LibraryWorkflowEntry>;
  readonly roles: ReadonlyArray<LibraryRoleEntry>;
} {
  return {
    workflows: environments
      .flatMap(({ environmentId, workflows }) =>
        workflows.map((workflow) => ({
          key: libraryItemKey(environmentId, workflow.id),
          environmentId,
          workflow,
          stagePath: workflowStagePath(workflow),
        })),
      )
      .sort((left, right) => byName(left.workflow, right.workflow)),
    roles: environments
      .flatMap(({ environmentId, roles }) =>
        roles.map((role) => ({ key: libraryItemKey(environmentId, role.id), environmentId, role })),
      )
      .sort((left, right) => byName(left.role, right.role)),
  };
}
