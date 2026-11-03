import { PROJECT_MANAGER_ROLE_ID, type EnvironmentId, type RoleConfig } from "@t3tools/contracts";

/** Roles are environment-local, so their ids only mean something with the environment. */
const libraryItemKey = (environmentId: EnvironmentId, id: string) => `${environmentId}:${id}`;

/** Why a role won't join new features' crews, or null when it will. */
export function roleAvailabilityNote(role: RoleConfig): string | null {
  if (!role.enabled) return "Off";
  // The project manager leads every feature rather than joining its crew.
  if (!role.autoCreateForFeature && role.id !== PROJECT_MANAGER_ROLE_ID) {
    return "Not on feature crews";
  }
  return null;
}

export interface EnvironmentLibrary {
  readonly environmentId: EnvironmentId;
  readonly roles: ReadonlyArray<RoleConfig>;
}

export interface LibraryRoleEntry {
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly role: RoleConfig;
}

/**
 * The Library's roles across environments, sorted by name. The same role on two environments
 * sits side by side, in environment order.
 */
export function libraryRoleEntries(
  environments: ReadonlyArray<EnvironmentLibrary>,
): ReadonlyArray<LibraryRoleEntry> {
  return environments
    .flatMap(({ environmentId, roles }) =>
      roles.map((role) => ({ key: libraryItemKey(environmentId, role.id), environmentId, role })),
    )
    .sort((left, right) =>
      left.role.name.localeCompare(right.role.name, undefined, { sensitivity: "base" }),
    );
}
