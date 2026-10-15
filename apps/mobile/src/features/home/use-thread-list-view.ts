import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import type { ThreadListView, ThreadListViewToggle } from "./thread-list-chrome";

/** Saves the List / Board view for `viewKey` (a logical bot key, or "all"). */
export function useSetThreadListView() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  return useCallback(
    (viewKey: string, view: ThreadListView) =>
      savePreferences({
        transform: (current) => ({
          threadListViewByBot: { ...current.threadListViewByBot, [viewKey]: view },
        }),
      }),
    [savePreferences],
  );
}

/**
 * The thread list column's view, remembered per bot. Null while no connected environment
 * runs workflows: the list then shows threads and offers no toggle.
 */
export function useThreadListView(
  viewKey: string,
  boardAvailable: boolean,
): ThreadListViewToggle | null {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const setView = useSetThreadListView();
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.threadListViewByBot?.[viewKey]
    : undefined;
  const view = boardAvailable && saved === "board" ? "board" : "list";
  return useMemo(
    () =>
      boardAvailable
        ? { view, onToggle: () => void setView(viewKey, view === "list" ? "board" : "list") }
        : null,
    [boardAvailable, setView, view, viewKey],
  );
}
