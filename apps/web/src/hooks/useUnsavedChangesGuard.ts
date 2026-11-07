import { useBlocker } from "@tanstack/react-router";
import { useEffect } from "react";

import { requestConfirmDialog } from "../confirmDialog";

let unsavedEditors = 0;

/** True while an open editor has changes that leaving would drop. */
export const hasUnsavedChanges = () => unsavedEditors > 0;

/**
 * Asks with `message` before an editor with unsaved changes is left: by navigating, by closing
 * the window, or by closing the Settings modal it sits in. While `saving`, leaving goes ahead.
 */
export function useUnsavedChangesGuard({
  unsaved,
  saving,
  message,
}: {
  readonly unsaved: boolean;
  readonly saving: boolean;
  readonly message: string;
}) {
  useBlocker({
    shouldBlockFn: async () => unsaved && !saving && (await requestConfirmDialog(message)) !== true,
    enableBeforeUnload: () => unsaved,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the app modal, outside this tree, that closing would drop changes, so it leaves through the router's prompt.
  useEffect(() => {
    if (!unsaved) return;
    unsavedEditors += 1;
    return () => {
      unsavedEditors -= 1;
    };
  }, [unsaved]);
}
