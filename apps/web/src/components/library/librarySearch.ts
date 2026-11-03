import { EnvironmentId } from "@t3tools/contracts";

/** What the Library's main pane shows: a role on an environment, or a new one. */
export interface LibrarySearch {
  readonly environmentId?: EnvironmentId;
  readonly roleId?: string;
  /** A new role, on `environmentId` when given. */
  readonly new?: "role";
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function validateLibrarySearch(raw: Record<string, unknown>): LibrarySearch {
  return {
    ...(nonEmpty(raw.environmentId)
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(nonEmpty(raw.roleId) ? { roleId: raw.roleId } : raw.new === "role" ? { new: "role" } : {}),
  };
}
