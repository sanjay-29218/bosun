import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { groupWorkThreads } from "@t3tools/client-runtime/state/work-groups";
import { useMemo } from "react";

/** The thread list's rows: a feature's or bot request's threads fold into one row. */
export function useWorkGroupedThreads(threads: ReadonlyArray<EnvironmentThreadShell>) {
  return useMemo(() => {
    const { primaries, groupByThreadKey } = groupWorkThreads(threads);
    return { listThreads: primaries, workGroups: groupByThreadKey };
  }, [threads]);
}
