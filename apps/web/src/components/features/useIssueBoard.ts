import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentIssue,
  EnvironmentMilestone,
} from "@t3tools/client-runtime/state/issue-board";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
import { formatEnvironmentQueryError } from "../../state/query";
import type { FeatureBoardTarget } from "./useFeatureBoard";

/**
 * Every read is a GitHub GraphQL query per project, so an open page re-reads slowly; the
 * Refresh button is there for when that is too slow.
 */
const ISSUES_REFRESH_MS = 120_000;

const issuesAtom = (target: FeatureBoardTarget) =>
  featuresEnvironment.issues({
    environmentId: target.environmentId,
    input: { projectId: target.projectId },
  });

/** Issues and milestones for every target, merged. Each project loads and fails on its own. */
export function useIssueBoard(targets: ReadonlyArray<FeatureBoardTarget>, enabled: boolean) {
  const key = enabled
    ? targets
        .map((target) => `${target.environmentId}:${target.projectId}`)
        .toSorted()
        .join(",")
    : "";
  // `targets` is rebuilt by callers on every render; the key is what identifies the set.
  const stableTargets = useMemo(() => (enabled ? targets : []), [key]);
  const resultsAtom = useMemo(
    () =>
      Atom.make((get) =>
        stableTargets.map((target) => ({ target, result: get(issuesAtom(target)) })),
      ).pipe(Atom.withLabel(`web-features:issues:${key}`)),
    [key, stableTargets],
  );
  const results = useAtomValue(resultsAtom);

  const refresh = useCallback(() => {
    for (const target of stableTargets) appAtomRegistry.refresh(issuesAtom(target));
  }, [stableTargets]);
  useEffect(() => {
    if (stableTargets.length === 0) return;
    const handle = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, ISSUES_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [refresh, stableTargets.length]);

  return useMemo(() => {
    const issues: EnvironmentIssue[] = [];
    const milestones: EnvironmentMilestone[] = [];
    const errors: string[] = [];
    /** Projects that answered but have nowhere to read issues from, with the reason. */
    const unavailable: Array<FeatureBoardTarget & { readonly reason: string }> = [];
    let pending = false;
    let truncated = false;
    let readAt: string | null = null;
    for (const { target, result } of results) {
      const value = Option.getOrNull(AsyncResult.value(result));
      if (value !== null) {
        const owner = { environmentId: target.environmentId, projectId: target.projectId };
        for (const issue of value.issues) issues.push({ ...issue, ...owner });
        for (const milestone of value.milestones) milestones.push({ ...milestone, ...owner });
        if (value.unavailable !== null) unavailable.push({ ...target, reason: value.unavailable });
        truncated ||= value.truncated;
        // The oldest read is what the page can vouch for.
        if (readAt === null || value.readAt < readAt) readAt = value.readAt;
      }
      if (result.waiting && value === null) pending = true;
      if (result._tag === "Failure" && !Cause.hasInterruptsOnly(result.cause))
        errors.push(formatEnvironmentQueryError(result.cause));
    }
    return {
      issues,
      milestones,
      errors,
      unavailable,
      /** True until every project has answered at least once. */
      pending,
      /** A re-read is in flight. */
      refreshing: results.some(({ result }) => result.waiting),
      truncated,
      readAt,
      refresh,
    };
  }, [refresh, results]);
}
