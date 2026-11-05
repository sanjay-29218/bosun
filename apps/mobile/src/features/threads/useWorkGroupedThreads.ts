import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  groupWorkThreads,
  nestChildFeatureGroups,
  resolveWorkGroupRouteRowKey,
  routeChildFeature,
  type WorkGroup,
} from "@t3tools/client-runtime/state/work-groups";
import { useMemo, useState } from "react";

import { childFeatureRowExpanded } from "./threadListV2";

/**
 * The thread list's rows: a feature's or bot request's threads fold into one row, and child
 * features fold under their parent's. A search lists children as rows of their own, so it finds
 * them.
 */
export function useWorkGroupedThreads(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: { readonly nestChildFeatures: boolean },
) {
  const { nestChildFeatures } = options;
  return useMemo(() => {
    const grouped = groupWorkThreads(threads);
    const { primaries, groupByThreadKey } = nestChildFeatures
      ? nestChildFeatureGroups(grouped.primaries, grouped.groupByThreadKey)
      : grouped;
    return { listThreads: primaries, workGroups: groupByThreadKey };
  }, [threads, nestChildFeatures]);
}

/**
 * The thread list's child-feature toggles, and `selectedRowKey`, the row to mark for
 * `selectedThreadKey`: a feature's row while one of its threads is open, unless it lists the open
 * child's own row.
 */
export function useChildFeatureExpansion(
  workGroups: ReadonlyMap<string, WorkGroup<EnvironmentThreadShell>>,
  selectedThreadKey: string | null,
) {
  const [toggles, setToggles] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const expanded = (rowKey: string, current: ReadonlyMap<string, boolean>) =>
    childFeatureRowExpanded({ rowKey, workGroups, toggles: current, selectedThreadKey });
  const toggle = (thread: EnvironmentThreadShell) => {
    const rowKey = `${thread.environmentId}:${thread.id}`;
    setToggles((current) => new Map(current).set(rowKey, !expanded(rowKey, current)));
  };
  const groupRowKey = resolveWorkGroupRouteRowKey(workGroups, selectedThreadKey);
  const listsOpenChild =
    groupRowKey !== null &&
    expanded(groupRowKey, toggles) &&
    routeChildFeature(workGroups.get(groupRowKey)!, selectedThreadKey) !== undefined;
  const selectedRowKey = listsOpenChild ? selectedThreadKey : (groupRowKey ?? selectedThreadKey);
  return { toggles, toggle, selectedRowKey };
}
