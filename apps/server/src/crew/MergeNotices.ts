import {
  CommandId,
  CREW_DISPATCH_STATE,
  featureIssueRef,
  headquartersProjectId,
  MessageId,
  projectHeadquartersRunId,
  type OrchestrationV2DomainEvent,
  type ProjectId,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { FeatureService } from "../features/FeatureService.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import {
  normalizeThreadPullRequestKey,
  threadPullRequestKeyOf,
  threadPullRequestKeysEqual,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import { CrewStore } from "./CrewStore.ts";

/**
 * Tells a project's manager once when a pull request its features or delegated tasks track
 * merges, naming their issues, so it can close them. It reads persisted snapshot updates, which
 * the pull request sync keeps refreshing for such work until it ends, rather than watches.
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

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const engine = yield* OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const features = yield* FeatureService;
  const crewStore = yield* CrewStore;
  const queryError = toPersistenceSqlError("MergeNotices.query");

  const trackedThreads = (projectId: ProjectId) =>
    projections
      .getThreadsWithPullRequests(undefined, { includeArchivedWork: true })
      .pipe(
        Effect.map((threads) =>
          threads.filter((thread) => thread.projectId === projectId && tracksWork(thread)),
        ),
      );

  const describe = Effect.fn("MergeNotices.describe")(function* (thread: TrackedThread) {
    if (thread.feature != null) {
      const feature = yield* features.get(thread.feature.id);
      const issue = feature?.issue ?? null;
      return [
        `Feature "${thread.feature.title}"${feature?.number === undefined ? "" : ` (F-${feature.number})`}`,
        issue === null
          ? "no issue linked"
          : `issue ${featureIssueRef(issue)}${issue.milestone ? `, milestone ${issue.milestone}` : ""}`,
      ].join(": ");
    }
    const issue = thread.issue ?? null;
    return `Task "${thread.title}" (thread ${thread.id}): ${
      issue === null
        ? "no issue linked"
        : `issue ${featureIssueRef(issue)}${issue.milestone ? `, milestone ${issue.milestone}` : ""}`
    }`;
  });

  /** One notice per project and pull request, naming every piece of work that tracks it. */
  const notify = Effect.fn("MergeNotices.notify")(function* (
    projectId: ProjectId,
    link: ThreadPullRequestLink,
  ) {
    const manager = yield* crewStore.getRun(projectHeadquartersRunId(projectId));
    if (manager === null || manager.dispatchState !== CREW_DISPATCH_STATE.STARTED) return;
    const key = threadPullRequestKeyOf(normalizeThreadPullRequestKey(link));
    const [noticed] = yield* sql`
      SELECT 1 FROM project_merge_notices
      WHERE project_id = ${projectId} AND pull_request_key = ${key}
    `.pipe(Effect.mapError(queryError));
    if (noticed !== undefined) return;
    const work = (yield* trackedThreads(projectId)).filter((thread) =>
      visibleThreadPullRequests(thread.pullRequests ?? []).some((candidate) =>
        threadPullRequestKeysEqual(candidate, link),
      ),
    );
    if (work.length === 0) return;
    // A feature's crew threads share its lead's pull request; the feature is named once.
    const seen = new Set<string>();
    const lines: Array<string> = [];
    for (const thread of work) {
      const id = thread.feature != null ? `feature:${thread.feature.id}` : `thread:${thread.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      lines.push(`- ${yield* describe(thread)}`);
    }
    const snapshot = link.snapshot;
    const base = `project-merge:${projectId}:${key}`;
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(base),
      messageId: MessageId.make(`message:${base}`),
      threadId: manager.threadId,
      text: [
        `Pull request ${link.repository}#${link.number} merged into ${snapshot?.baseBranch ?? "its base branch"}: ${snapshot?.title ?? ""} (${link.url}).`,
        `It carries:\n${lines.join("\n")}`,
      ].join("\n\n"),
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "server",
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
      yield* notify(thread.projectId, link);
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
