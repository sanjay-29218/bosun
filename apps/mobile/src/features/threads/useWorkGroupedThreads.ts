import { isHiddenStageThread } from "@t3tools/client-runtime/crew-stage";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { groupWorkThreads } from "@t3tools/client-runtime/state/work-groups";
import { useMemo } from "react";

/**
 * The thread list's rows: a feature's or bot request's threads fold into one row, and a
 * feature's earlier stages show only inside it.
 */
export function useWorkGroupedThreads(threads: ReadonlyArray<EnvironmentThreadShell>) {
  return useMemo(() => {
    const { primaries, groupByThreadKey } = groupWorkThreads(
      threads.filter((thread) => !isHiddenStageThread(thread)),
      threads.filter((thread) => isHiddenStageThread(thread)),
    );
    return { listThreads: primaries, workGroups: groupByThreadKey };
  }, [threads]);
}
