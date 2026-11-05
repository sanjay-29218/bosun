import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { formatEnvironmentQueryError } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { toastManager } from "../ui/toast";

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
