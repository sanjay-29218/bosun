import { IssueOperationError, type IssueList, type ProjectId } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";

/** How long a project's issue list is shared before the host is asked again. */
const LIST_CACHE_TTL = Duration.seconds(30);
const LIST_CACHE_CAPACITY = 256;

export class IssueService extends Context.Service<
  IssueService,
  {
    /**
     * The project's issues and open milestones from its repository host. A project whose host
     * cannot list issues answers with `unavailable` rather than failing.
     */
    readonly list: (projectId: ProjectId) => Effect.Effect<IssueList, IssueOperationError>;
  }
>()("t3/issues/IssueService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const listUncached = Effect.fn("IssueService.list")(function* (projectId: ProjectId) {
    const project = yield* projects.get(projectId).pipe(
      Effect.tapError((error) => Effect.logWarning("Issue list project read failed", { error })),
      Effect.mapError(() => new IssueOperationError({ reason: "The project could not be read." })),
    );
    if (Option.isNone(project)) {
      return yield* new IssueOperationError({ reason: "Project not found." });
    }
    const cwd = project.value.workspaceRoot;
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const unavailable = (reason: string): IssueList => ({
      repository: null,
      unavailable: reason,
      issues: [],
      milestones: [],
      truncated: false,
      readAt,
    });

    const handle = yield* sourceControl.resolveHandle({ cwd }).pipe(Effect.option);
    if (Option.isNone(handle) || handle.value.context === null) {
      return unavailable("Issues need a Git repository with a GitHub remote.");
    }
    const { provider, context } = handle.value;
    if (provider.listIssues === undefined) {
      return unavailable(
        `Issues need a GitHub repository. This project's remote is on ${context.provider.name}.`,
      );
    }
    const list = yield* provider.listIssues({ cwd }).pipe(
      Effect.tapError((error) => Effect.logWarning("Issue list read failed", { projectId, error })),
      Effect.mapError((error) => new IssueOperationError({ reason: error.detail })),
    );
    return { ...list, unavailable: null, readAt } satisfies IssueList;
  });

  // Concurrent reads of one project share a host request, and answers are shared for a while.
  // Failures are dropped at once so a fixed credential or network shows on the next read.
  const listCache = yield* Cache.makeWith(listUncached, {
    capacity: LIST_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
  });

  return IssueService.of({
    // A reader can join a lookup still finishing a previous reader's cancellation.
    list: Effect.fn("IssueService.list")((projectId) =>
      Cache.get(listCache, projectId).pipe(
        Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Cache.get(listCache, projectId)),
      ),
    ),
  });
});

export const layer = Layer.effect(IssueService, make);
