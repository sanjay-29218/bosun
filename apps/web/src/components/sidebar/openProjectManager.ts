import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { toastManager } from "../ui/toast";

export interface ScopedProjectManager {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The sidebar's key for the project, which Settings → Projects selects by. */
  readonly projectKey: string;
}

/**
 * The manager of the one project the sidebar is scoped to, or null with All projects, several
 * projects, or a project with no manager: one that is off, Scratch, a bot's home, or on a server
 * without features.
 */
export function useScopedProjectManager(): ScopedProjectManager | null {
  const scopeKeys = useUiStateStore((store) => store.sidebarProjectScopeKeys);
  const groups = useSettingsProjectGroups();
  const { environments } = useEnvironments();
  const group = scopeKeys.length === 1 ? groups.find((g) => g.projectKey === scopeKeys[0]) : null;
  const member = group?.memberProjects.find(
    (candidate) =>
      candidate.isScratch !== true &&
      candidate.isBotHome !== true &&
      environments.find((environment) => environment.environmentId === candidate.environmentId)
        ?.serverConfig?.environment.capabilities.workflows === true,
  );
  const settings = useEnvironmentQuery(
    member
      ? rolesEnvironment.projectManager({
          environmentId: member.environmentId,
          input: { projectId: member.id },
        })
      : null,
  );
  if (!group || !member || settings.data?.enabled === false) return null;
  return {
    environmentId: member.environmentId,
    projectId: member.id,
    title: group.displayName,
    projectKey: group.projectKey,
  };
}

export const OPEN_PROJECT_MANAGER_ITEM = {
  id: "open-project-manager",
  label: "Open project manager",
  icon: "message-square",
} as const;

/** Opens a project's manager thread, which the server makes on first use. */
export function useOpenProjectManager() {
  const navigate = useNavigate();
  const open = useAtomCommand(rolesEnvironment.openProjectManager, { reportFailure: false });
  return (project: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title: string;
  }) =>
    open({ environmentId: project.environmentId, input: { projectId: project.projectId } }).then(
      (result) => {
        if (result._tag === "Success") {
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(project.environmentId, result.value.threadId),
            ),
          });
        } else {
          toastManager.add({
            type: "error",
            title: `Could not open ${project.title}'s project manager`,
            description: formatEnvironmentQueryError(result.cause),
          });
        }
      },
    );
}
