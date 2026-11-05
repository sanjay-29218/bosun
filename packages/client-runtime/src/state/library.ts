import {
  PROJECT_MANAGER_ROLE_ID,
  type EnvironmentId,
  type RoleConfig,
  type WorkflowConfig,
} from "@t3tools/contracts";

/** Roles and workflows are environment-local, so their ids only mean something with it. */
const libraryItemKey = (environmentId: EnvironmentId, id: string) => `${environmentId}:${id}`;

/** Why a role won't take part in new features, or null when a workflow leads or uses it. */
export function roleAvailabilityNote(
  role: RoleConfig,
  workflows: ReadonlyArray<WorkflowConfig>,
): string | null {
  if (!role.enabled) return "Off";
  // It manages each project from a thread of its own, never inside a workflow.
  if (role.id === PROJECT_MANAGER_ROLE_ID) return null;
  const used = workflows.some(
    (workflow) => workflow.leadRoleId === role.id || workflow.crewRoleIds.includes(role.id),
  );
  return used ? null : "Not in a workflow";
}

export interface EnvironmentLibrary {
  readonly environmentId: EnvironmentId;
  readonly roles: ReadonlyArray<RoleConfig>;
  readonly workflows: ReadonlyArray<WorkflowConfig>;
}

interface LibraryEntry<Item> {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly item: Item;
}
export type LibraryRoleEntry = LibraryEntry<RoleConfig>;
export type LibraryWorkflowEntry = LibraryEntry<WorkflowConfig>;

/** Every environment's items, sorted by name; one id on two environments sits side by side. */
function libraryEntries<Item extends { readonly id: string; readonly name: string }>(
  environments: ReadonlyArray<EnvironmentLibrary>,
  items: (library: EnvironmentLibrary) => ReadonlyArray<Item>,
): ReadonlyArray<LibraryEntry<Item>> {
  return environments
    .flatMap((library) =>
      items(library).map((item) => ({
        key: libraryItemKey(library.environmentId, item.id),
        environmentId: library.environmentId,
        item,
      })),
    )
    .sort((left, right) =>
      left.item.name.localeCompare(right.item.name, undefined, { sensitivity: "base" }),
    );
}

export const libraryRoleEntries = (environments: ReadonlyArray<EnvironmentLibrary>) =>
  libraryEntries(environments, (library) => library.roles);

export const libraryWorkflowEntries = (environments: ReadonlyArray<EnvironmentLibrary>) =>
  libraryEntries(environments, (library) => library.workflows);
