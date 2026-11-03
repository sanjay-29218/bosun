import { EnvironmentId } from "@t3tools/contracts";

/** What the Library's main pane shows: a workflow or role on an environment, or a new one. */
export interface LibrarySearch {
  readonly environmentId?: EnvironmentId;
  readonly workflowId?: string;
  readonly roleId?: string;
  /** A new workflow or role, on `environmentId` when given. */
  readonly new?: "workflow" | "role";
}

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function validateLibrarySearch(raw: Record<string, unknown>): LibrarySearch {
  return {
    ...(nonEmpty(raw.environmentId)
      ? { environmentId: EnvironmentId.make(raw.environmentId) }
      : {}),
    ...(nonEmpty(raw.workflowId)
      ? { workflowId: raw.workflowId }
      : nonEmpty(raw.roleId)
        ? { roleId: raw.roleId }
        : raw.new === "workflow" || raw.new === "role"
          ? { new: raw.new }
          : {}),
  };
}
