import { projectManagerLook } from "@t3tools/client-runtime/project-manager-look";
import type { EnvironmentId, ProjectId, ProjectManagerIcon as Icon } from "@t3tools/contracts";
import { memo, type ComponentProps } from "react";

import { useEnvironmentQuerySelector } from "../../state/query";
import { rolesEnvironment } from "../../state/roles";
import { BotAvatar } from "../BotAvatar";

/** The look chosen for a project's manager, or null while none is (or it hasn't loaded). */
export function useProjectManagerIcon(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): Icon | null {
  return useEnvironmentQuerySelector(
    environmentId === null || projectId === null
      ? null
      : rolesEnvironment.projectManager({ environmentId, input: { projectId } }),
    (result) => (result._tag === "Success" ? result.value.icon : null),
  );
}

/** A project's manager as a bot: its chosen look, else the one derived from its project. */
export const ProjectManagerAvatar = memo(function ProjectManagerAvatar({
  projectId,
  icon,
  size,
  working = false,
  className,
}: {
  readonly projectId: ProjectId;
  readonly icon: Icon | null;
  readonly size: NonNullable<ComponentProps<typeof BotAvatar>["size"]>;
  /** Glances now and then while it works; the chat header leaves it still. */
  readonly working?: boolean;
  readonly className?: string;
}) {
  const look = projectManagerLook(projectId, icon);
  return (
    <BotAvatar
      avatar={look.avatar}
      color={look.color}
      size={size}
      working={working}
      {...(className ? { className } : {})}
    />
  );
});
