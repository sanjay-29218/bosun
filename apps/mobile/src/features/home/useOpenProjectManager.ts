import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";
import { Alert } from "react-native";

import { rolesEnvironment } from "../../state/roles";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Opens a project's manager thread, which the server creates on first use, through the screen's
 * own `selectThread`.
 */
export function useOpenProjectManager(
  selectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void,
) {
  const open = useAtomCommand(rolesEnvironment.openProjectManager, { reportFailure: false });
  return useCallback(
    async (manager: {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly title: string;
    }) => {
      const result = await open({
        environmentId: manager.environmentId,
        input: { projectId: manager.projectId },
      });
      if (result._tag === "Success") {
        selectThread({ environmentId: manager.environmentId, id: result.value.threadId });
      } else {
        Alert.alert(
          `Could not open ${manager.title}'s project manager`,
          Cause.pretty(result.cause),
        );
      }
    },
    [open, selectThread],
  );
}
