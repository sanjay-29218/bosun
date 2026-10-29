import { useAtomValue } from "@effect/atom-react";
import {
  issueKey,
  ticketIssue,
  type EnvironmentIssue,
  type EnvironmentMilestone,
} from "@t3tools/client-runtime/state/issue-board";
import type { Ticket } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

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

const ticketsAtom = (target: FeatureBoardTarget) =>
  featuresEnvironment.tickets({
    environmentId: target.environmentId,
    input: { projectId: target.projectId },
  });

const issueBoardFor = (key: string, targets: ReadonlyArray<FeatureBoardTarget>) => ({
  key,
  targets,
  atom: Atom.make((get) =>
    targets.map((target) => ({
      target,
      result: get(issuesAtom(target)),
      tickets: get(ticketsAtom(target)),
    })),
  ).pipe(Atom.withLabel(`web-features:issues:${key}`)),
});

/**
 * Issues, tickets and milestones for every target, merged; tickets are rows with a `ticketId`.
 * Each project loads and fails on its own.
 */
export function useIssueBoard(targets: ReadonlyArray<FeatureBoardTarget>, enabled: boolean) {
  const key = enabled
    ? targets
        .map((target) => `${target.environmentId}:${target.projectId}`)
        .toSorted()
        .join(",")
    : "";
  // `targets` is rebuilt by callers on every render; the key is what identifies the set, so
  // the atom is rebuilt only when the key changes.
  const [board, setBoard] = useState(() => issueBoardFor(key, enabled ? targets : []));
  if (board.key !== key) setBoard(issueBoardFor(key, enabled ? targets : []));
  const stableTargets = board.targets;
  const resultsAtom = board.atom;
  const results = useAtomValue(resultsAtom);

  const refresh = () => {
    for (const target of stableTargets) {
      appAtomRegistry.refresh(issuesAtom(target));
      appAtomRegistry.refresh(ticketsAtom(target));
    }
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Polls GitHub issues while the page is mounted; the interval is cleared on unmount.
  useEffect(() => {
    if (stableTargets.length === 0) return;
    const handle = window.setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, ISSUES_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [refresh, stableTargets.length]);

  const issues: EnvironmentIssue[] = [];
  const milestones: EnvironmentMilestone[] = [];
  const errors: string[] = [];
  /** Projects that answered but have nowhere to read issues from, with the reason. */
  const unavailable: Array<FeatureBoardTarget & { readonly reason: string }> = [];
  /** Projects whose host files issues, by `environmentId:projectId`. */
  const issueHosts = new Set<string>();
  /** Tickets by their row's `issueKey`, for the detail view. */
  const tickets = new Map<string, Ticket>();
  let pending = false;
  let truncated = false;
  let readAt: string | null = null;
  for (const entry of results) {
    const { target, result } = entry;
    const value = Option.getOrNull(AsyncResult.value(result));
    if (value !== null) {
      const owner = { environmentId: target.environmentId, projectId: target.projectId };
      for (const issue of value.issues) issues.push({ ...issue, ...owner, ticketId: null });
      for (const milestone of value.milestones) milestones.push({ ...milestone, ...owner });
      if (value.unavailable !== null) unavailable.push({ ...target, reason: value.unavailable });
      else issueHosts.add(`${target.environmentId}:${target.projectId}`);
      if (value.truncated) truncated = true;
      // The oldest read is what the page can vouch for.
      if (readAt === null || value.readAt < readAt) readAt = value.readAt;
    }
    if (result.waiting && value === null) pending = true;
    if (result._tag === "Failure" && !Cause.hasInterruptsOnly(result.cause))
      errors.push(formatEnvironmentQueryError(result.cause));

    for (const ticket of Option.getOrElse(AsyncResult.value(entry.tickets), () => [])) {
      const row = ticketIssue(ticket, target.environmentId);
      issues.push(row);
      tickets.set(issueKey(row), ticket);
    }
    if (entry.tickets._tag === "Failure" && !Cause.hasInterruptsOnly(entry.tickets.cause))
      errors.push(formatEnvironmentQueryError(entry.tickets.cause));
  }
  return {
    issues,
    tickets,
    issueHosts,
    milestones,
    errors,
    unavailable,
    /** True until every project has answered at least once. */
    pending,
    /** A re-read is in flight. */
    refreshing: results.some((entry) => entry.result.waiting || entry.tickets.waiting),
    truncated,
    readAt,
    refresh,
  };
}
