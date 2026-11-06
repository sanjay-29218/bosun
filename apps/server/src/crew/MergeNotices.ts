import {
  CREW_DISPATCH_STATE,
  type FeatureIssue,
  featureIssueRef,
  headquartersProjectId,
  projectHeadquartersRunId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { FeatureService } from "../features/FeatureService.ts";
import { IssueService } from "../issues/IssueService.ts";
import { NoticeInbox } from "../features/NoticeInbox.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import { TicketService } from "../tickets/TicketService.ts";
import { CrewStore } from "./CrewStore.ts";

/**
 * Tells a project's manager once when a pull request its features or delegated tasks track
 * merges, naming their issues, so it can close them; with `closeIssuesOnMerge` on, the merge
 * closes them itself. It reads persisted snapshot updates, which the pull request sync keeps
 * refreshing for such work until it ends, rather than watches.
 */
export class MergeNotices extends Context.Service<
  MergeNotices,
  {
    /** Notices a merge a snapshot update shows, for the project of `threadId`. */
    readonly handleLink: (threadId: ThreadId, link: ThreadPullRequestLink) => Effect.Effect<void>;
    /** Sends the notices of merges each manager missed, such as one before a restart. */
    readonly reconcile: () => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/crew/MergeNotices") {}

type TrackedThread = ProjectionStore.ProjectionThreadPullRequests;

/** A feature's thread, or a task a project's manager delegated. */
const tracksWork = (thread: TrackedThread) =>
  thread.feature != null || headquartersProjectId(thread.lineage.parentThreadId ?? "") !== null;

/** Turning `closeIssuesOnMerge` on must not sweep the issues of merges long past. */
const CLOSE_ISSUES_MERGED_WITHIN = Duration.days(7);

/** An issue link without its query, fragment or trailing slash, for comparing two links. */
const sameIssueUrl = (left: string, right: string) => {
  const normalize = (value: string) => {
    if (!URL.canParse(value)) return value;
    const url = new URL(value);
    return `${url.host}${url.pathname.replace(/\/+$/u, "")}`.toLowerCase();
  };
  return normalize(left) === normalize(right);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const features = yield* FeatureService;
  const crewStore = yield* CrewStore;
  const inbox = yield* NoticeInbox;
  const settings = yield* ServerSettingsService;
  const issues = yield* IssueService;
  const tickets = yield* TicketService;
  const queryError = toPersistenceSqlError("MergeNotices.query");

  const trackedThreads = (projectId: ProjectId) =>
    projections
      .getThreadsWithPullRequests(undefined, { includeArchivedWork: true })
      .pipe(
        Effect.map((threads) =>
          threads.filter((thread) => thread.projectId === projectId && tracksWork(thread)),
        ),
      );

  const threadsWith = (projectId: ProjectId, link: ThreadPullRequestLink) =>
    trackedThreads(projectId).pipe(
      Effect.map((threads) =>
        threads.filter((thread) =>
          visibleThreadPullRequests(thread.pullRequests ?? []).some((candidate) =>
            threadPullRequestKeysEqual(candidate, link),
          ),
        ),
      ),
    );

  const issueOf = Effect.fn("MergeNotices.issueOf")(function* (thread: TrackedThread) {
    if (thread.feature == null) return thread.issue ?? null;
    return (yield* features.get(thread.feature.id))?.issue ?? null;
  });

  const describe = Effect.fn("MergeNotices.describe")(function* (
    thread: TrackedThread,
    closed: ReadonlySet<string>,
  ) {
    const feature = thread.feature == null ? null : yield* features.get(thread.feature.id);
    const issue = thread.feature == null ? (thread.issue ?? null) : (feature?.issue ?? null);
    const issueText =
      issue === null
        ? "no issue linked"
        : `issue ${featureIssueRef(issue)}${issue.milestone ? `, milestone ${issue.milestone}` : ""}${
            closed.has(featureIssueRef(issue)) ? " (closed by the merge)" : ""
          }`;
    if (thread.feature != null) {
      return `Feature "${thread.feature.title}"${feature?.number === undefined ? "" : ` (F-${feature.number})`}: ${issueText}`;
    }
    return `Task "${thread.title}" (thread ${thread.id}): ${issueText}`;
  });

  /** Closes one linked issue or ticket if it is still open; true when it closed it. */
  const closeIssue = Effect.fn("MergeNotices.closeIssue")(function* (
    projectId: ProjectId,
    issue: FeatureIssue,
  ) {
    if (issue.ticketId !== undefined) {
      const ticket = yield* tickets.get(projectId, issue.ticketId);
      if (ticket.state !== "open") return false;
      yield* tickets.update({
        projectId,
        ticketId: issue.ticketId,
        state: "closed",
        closedReason: "completed",
      });
      return true;
    }
    // Trackers the host can't reach, such as Linear, stay as they are.
    if (issue.key !== undefined) return false;
    // The number names an issue of the project's own repository only when the links agree.
    const current = yield* issues.get(projectId, issue.number);
    if (!sameIssueUrl(current.url, issue.url) || current.state !== "open") return false;
    yield* issues.setState({
      projectId,
      number: issue.number,
      state: "closed",
      reason: "completed",
    });
    return true;
  });

  /**
   * With `closeIssuesOnMerge` on, closes the open issues linked to the work a fresh merge
   * carries, once per pull request. Answers the references it closed.
   */
  const closeIssues = Effect.fn("MergeNotices.closeIssues")(function* (
    projectId: ProjectId,
    link: ThreadPullRequestLink,
  ) {
    const closed = new Set<string>();
    const current = yield* settings.getSettings;
    if (!resolveProjectSettings(current, projectId).settings.closeIssuesOnMerge) return closed;
    const mergedAt = link.snapshot?.mergedAt;
    if (
      mergedAt != null &&
      Date.parse(mergedAt) <
        DateTime.toEpochMillis(yield* DateTime.now) - Duration.toMillis(CLOSE_ISSUES_MERGED_WITHIN)
    ) {
      return closed;
    }
    const key = threadPullRequestKeyOf(normalizeThreadPullRequestKey(link));
    const [done] = yield* sql`
      SELECT 1 FROM merge_closed_issues
      WHERE project_id = ${projectId} AND pull_request_key = ${key}
    `.pipe(Effect.mapError(queryError));
    if (done !== undefined) return closed;
    const seen = new Set<string>();
    for (const thread of yield* threadsWith(projectId, link)) {
      const issue = yield* issueOf(thread);
      if (issue === null || seen.has(featureIssueRef(issue))) continue;
      seen.add(featureIssueRef(issue));
      const didClose = yield* closeIssue(projectId, issue).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Closing a merged pull request's issue failed", {
            projectId,
            issue: featureIssueRef(issue),
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (didClose) closed.add(featureIssueRef(issue));
    }
    yield* sql`
      INSERT OR IGNORE INTO merge_closed_issues (project_id, pull_request_key, closed_at)
      VALUES (${projectId}, ${key}, ${DateTime.formatIso(yield* DateTime.now)})
    `.pipe(Effect.mapError(queryError));
    return closed;
  });

  /** One notice per project and pull request, naming every piece of work that tracks it. */
  const notify = Effect.fn("MergeNotices.notify")(function* (
    projectId: ProjectId,
    link: ThreadPullRequestLink,
    closed: ReadonlySet<string> = new Set(),
  ) {
    const manager = yield* crewStore.getRun(projectHeadquartersRunId(projectId));
    if (manager === null || manager.dispatchState !== CREW_DISPATCH_STATE.STARTED) return;
    const key = threadPullRequestKeyOf(normalizeThreadPullRequestKey(link));
    const [noticed] = yield* sql`
      SELECT 1 FROM project_merge_notices
      WHERE project_id = ${projectId} AND pull_request_key = ${key}
    `.pipe(Effect.mapError(queryError));
    if (noticed !== undefined) return;
    const work = yield* threadsWith(projectId, link);
    if (work.length === 0) return;
    // A feature's crew threads share its lead's pull request; the feature is named once.
    const seen = new Set<string>();
    const lines: Array<string> = [];
    for (const thread of work) {
      const id = thread.feature != null ? `feature:${thread.feature.id}` : `thread:${thread.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      lines.push(`- ${yield* describe(thread, closed)}`);
    }
    const snapshot = link.snapshot;
    yield* inbox.post({
      threadId: manager.threadId,
      key: `project-merge:${projectId}:${key}`,
      text: [
        `Pull request ${link.repository}#${link.number} merged into ${snapshot?.baseBranch ?? "its base branch"}: ${snapshot?.title ?? ""} (${link.url}).`,
        `It carries:\n${lines.join("\n")}`,
      ].join("\n\n"),
    });
    yield* sql`
      INSERT OR IGNORE INTO project_merge_notices (project_id, pull_request_key, notified_at)
      VALUES (${projectId}, ${key}, ${DateTime.formatIso(yield* DateTime.now)})
    `.pipe(Effect.mapError(queryError));
  });

  const handleLink: MergeNotices["Service"]["handleLink"] = Effect.fn("MergeNotices.handleLink")(
    function* (threadId, link) {
      if (link.snapshot?.state !== "merged") return;
      const [thread] = yield* projections.getThreadsWithPullRequests(threadId, {
        includeArchivedWork: true,
      });
      if (thread === undefined || !tracksWork(thread)) return;
      const closed = yield* closeIssues(thread.projectId, link).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Closing a merged pull request's issues failed", {
            threadId,
            cause,
          }).pipe(Effect.as(new Set<string>())),
        ),
      );
      yield* notify(thread.projectId, link, closed);
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Telling a project's manager about a merge failed", {
            threadId,
            cause,
          }),
        ),
      ),
  );

  const reconcile: MergeNotices["Service"]["reconcile"] = Effect.fn("MergeNotices.reconcile")(
    function* () {
      const managers = yield* sql<{ readonly projectId: ProjectId; readonly createdAt: string }>`
        SELECT project_id AS projectId, created_at AS createdAt FROM crew_runs
        WHERE id LIKE 'project-hq:%'
      `.pipe(Effect.mapError(queryError));
      for (const manager of managers) {
        for (const thread of yield* trackedThreads(manager.projectId)) {
          for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
            const mergedAt = link.snapshot?.state === "merged" ? link.snapshot.mergedAt : null;
            // Merges from before the manager existed are history, not news.
            if (mergedAt == null || Date.parse(mergedAt) < Date.parse(manager.createdAt)) continue;
            yield* notify(manager.projectId, link);
          }
        }
      }
    },
    Effect.catchCause((cause) => Effect.logWarning("Reconciling merge notices failed", { cause })),
  );

  const onEvent = (event: OrchestrationV2DomainEvent) =>
    event.type === "thread.pull-request-link-updated"
      ? handleLink(event.threadId, event.payload)
      : Effect.void;

  const start: MergeNotices["Service"]["start"] = Effect.fn("MergeNotices.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Merge notice stream failed", { cause })),
      ),
    );
    yield* forkParked(reconcile());
  });

  return MergeNotices.of({ handleLink, reconcile, start });
});

export const layer = Layer.effect(MergeNotices, make);
