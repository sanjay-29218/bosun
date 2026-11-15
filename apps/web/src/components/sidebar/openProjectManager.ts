import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { useSettingsProjectGroups } from "../settings/useSettingsProjectGroups";
import { toastManager } from "../ui/toast";
import { latestStandingOpen } from "./standingOpen";

export interface ScopedProjectManager {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  /** The sidebar's key for the project, which Settings → Projects selects by. */
  readonly projectKey: string;
  /** The machine the manager lives on, when the project is on several. */
  readonly homeLabel: string | null;
}

/**
 * The manager of the one project the sidebar is scoped to, on the copy it lives on, or null with
 * All projects, several projects, or a project with no manager: one that is off, Scratch, a bot's
 * home, on a server without features, or living on a machine this client doesn't see.
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
      candidate.remoteManager == null &&
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
  const several = new Set(group.memberProjects.map((copy) => copy.environmentId)).size > 1;
  return {
    environmentId: member.environmentId,
    projectId: member.id,
    title: group.displayName,
    projectKey: group.projectKey,
    homeLabel: several ? member.environmentLabel : null,
  };
}

export const OPEN_PROJECT_MANAGER_ITEM = {
  id: "open-project-manager",
  label: "Open project manager",
  icon: "message-square",
} as const;

/**
 * Opens a project's manager thread, which the server makes on first use, on the machine it lives
 * on: a copy whose manager lives elsewhere opens that one. A later headquarters or manager open
 * wins over this one.
 */
export function useOpenProjectManager() {
  const navigate = useNavigate();
  const open = useAtomCommand(rolesEnvironment.openProjectManager, { reportFailure: false });
  const projects = useProjects();
  const { environments } = useEnvironments();
  return (requested: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly title: string;
  }) => {
    const home = projects.find(
      (candidate) =>
        candidate.environmentId === requested.environmentId && candidate.id === requested.projectId,
    )?.remoteManager;
    if (
      home != null &&
      !environments.some((environment) => environment.environmentId === home.environmentId)
    ) {
      toastManager.add({
        type: "error",
        title: `${requested.title}'s project manager lives on ${home.homeLabel}`,
        description: `Connect to ${home.homeLabel} to open it.`,
      });
      return Promise.resolve();
    }
    const project =
      home == null
        ? requested
        : { ...requested, environmentId: home.environmentId, projectId: home.projectId };
    return latestStandingOpen(
      open({ environmentId: project.environmentId, input: { projectId: project.projectId } }),
    ).then((latest) => {
      if (latest === null) return;
      const result = latest.value;
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
    });
  };
}
