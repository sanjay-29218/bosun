import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import {
  indexIssueStructure,
  issueKey,
  ticketIssue,
  type EnvironmentIssue,
  type EnvironmentMilestone,
} from "@t3tools/client-runtime/state/issue-board";
import type { Ticket } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { featuresEnvironment } from "../../state/features";
import { formatEnvironmentQueryError } from "../../state/query";
import type { FeatureBoardTarget } from "./useFeatureBoard";

/**
 * Every read is a GitHub GraphQL query per project, so an open page polls slowly. Opening the
 * board, the Refresh button, and a turn ending in the project read GitHub sooner.
 */
const ISSUES_REFRESH_MS = 120_000;
/** Opening the board again within this long of the last read keeps that read. */
const OPEN_REFRESH_AFTER_MS = 10_000;
/** When each project's last forced read was sent, so opens during an in-flight read skip it. */
const forcedReadSentAt = new Map<string, number>();
const targetKey = (target: FeatureBoardTarget) => `${target.environmentId}:${target.projectId}`;

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

/** The board's rows from every project's reads. */
function deriveIssueBoard(results: Atom.Type<ReturnType<typeof issueBoardFor>["atom"]>) {
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
      else issueHosts.add(targetKey(target));
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
    milestones,
    errors,
    unavailable,
    issueHosts,
    tickets,
    pending,
    truncated,
    readAt,
    structure: indexIssueStructure(issues),
  };
}

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

  const {
    issues,
    milestones,
    errors,
    unavailable,
    issueHosts,
    tickets,
    pending,
    truncated,
    readAt,
    structure,
  } = deriveIssueBoard(results);
  const refresh = () => {
    for (const target of stableTargets) {
      appAtomRegistry.refresh(issuesAtom(target));
      appAtomRegistry.refresh(ticketsAtom(target));
    }
  };
  /** Reads GitHub past the server's shared read; the server then tells this board to re-read. */
  const refreshFromHost = (targets: ReadonlyArray<FeatureBoardTarget> = stableTargets) => {
    for (const target of targets) {
      forcedReadSentAt.set(targetKey(target), Date.now());
      appAtomRegistry.refresh(ticketsAtom(target));
      void runAtomCommand(
        appAtomRegistry,
        featuresEnvironment.refreshIssues,
        { environmentId: target.environmentId, input: { projectId: target.projectId } },
        { reportFailure: false },
      ).then((result) => {
        // A server without the forced read still answers a plain one.
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
          appAtomRegistry.refresh(issuesAtom(target));
      });
    }
  };
  const onOpen = useEffectEvent(() => {
    const age = readAt === null ? Infinity : Date.now() - Date.parse(readAt);
    if (age < OPEN_REFRESH_AFTER_MS) return;
    const now = Date.now();
    const stale = stableTargets.filter(
      (target) => !(now - (forcedReadSentAt.get(targetKey(target)) ?? 0) < OPEN_REFRESH_AFTER_MS),
    );
    if (stale.length > 0) refreshFromHost(stale);
  });
  const onPoll = useEffectEvent(refresh);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads GitHub when the board opens or its projects change, then polls while it is mounted; the interval is cleared on unmount.
  useEffect(() => {
    if (stableTargets.length === 0) return;
    onOpen();
    const handle = window.setInterval(() => {
      if (document.visibilityState === "visible") onPoll();
    }, ISSUES_REFRESH_MS);
    return () => window.clearInterval(handle);
  }, [stableTargets]);

  return {
    issues,
    /** The loaded issues by URL and each parent's sub-issues. */
    structure,
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
    refresh: () => refreshFromHost(),
  };
}
