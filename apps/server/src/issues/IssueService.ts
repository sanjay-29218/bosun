import {
  IssueOperationError,
  type IssueClosedReason,
  type IssueDetail,
  type IssueList,
  type ProjectId,
  type RepositoryIssue,
} from "@t3tools/contracts";
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
    /** One issue with its description and first comments, read from the host each time. */
    readonly get: (
      projectId: ProjectId,
      number: number,
    ) => Effect.Effect<IssueDetail, IssueOperationError>;
    readonly create: (input: {
      readonly projectId: ProjectId;
      readonly title: string;
      readonly body: string;
    }) => Effect.Effect<RepositoryIssue, IssueOperationError>;
    readonly setState: (input: {
      readonly projectId: ProjectId;
      readonly number: number;
      readonly state: "open" | "closed";
      readonly reason?: IssueClosedReason | undefined;
    }) => Effect.Effect<RepositoryIssue, IssueOperationError>;
  }
>()("t3/issues/IssueService") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

  const workspaceRoot = Effect.fn("IssueService.workspaceRoot")(function* (projectId: ProjectId) {
    const project = yield* projects.get(projectId).pipe(
      Effect.tapError((error) => Effect.logWarning("Issue project read failed", { error })),
      Effect.mapError(() => new IssueOperationError({ reason: "The project could not be read." })),
    );
    if (Option.isNone(project)) {
      return yield* new IssueOperationError({ reason: "Project not found." });
    }
    return project.value.workspaceRoot;
  });

  /** Why the project has no issues to read, or its host's provider and checkout. */
  const issueHost = Effect.fn("IssueService.issueHost")(function* (projectId: ProjectId) {
    const cwd = yield* workspaceRoot(projectId);
    const handle = yield* sourceControl.resolveHandle({ cwd }).pipe(Effect.option);
    if (Option.isNone(handle) || handle.value.context === null) {
      return { unavailable: "Issues need a Git repository with a GitHub remote." } as const;
    }
    const { provider, context } = handle.value;
    const listIssues = provider.listIssues;
    if (listIssues === undefined) {
      return {
        unavailable: `Issues need a GitHub repository. This project's remote is on ${context.provider.name}.`,
      } as const;
    }
    return { cwd, provider, listIssues } as const;
  });

  const requireIssueHost = Effect.fn("IssueService.requireIssueHost")(function* (
    projectId: ProjectId,
  ) {
    const host = yield* issueHost(projectId);
    if ("unavailable" in host) return yield* new IssueOperationError({ reason: host.unavailable });
    return host;
  });

  const hostFailure = (operation: string, projectId: ProjectId) => (error: { detail: string }) =>
    Effect.logWarning(`Issue ${operation} failed`, { projectId, error }).pipe(
      Effect.andThen(Effect.fail(new IssueOperationError({ reason: error.detail }))),
    );

  const listUncached = Effect.fn("IssueService.list")(function* (projectId: ProjectId) {
    const readAt = DateTime.formatIso(yield* DateTime.now);
    const unavailable = (reason: string): IssueList => ({
      repository: null,
      unavailable: reason,
      issues: [],
      milestones: [],
      truncated: false,
      readAt,
    });

    const host = yield* issueHost(projectId);
    if ("unavailable" in host) return unavailable(host.unavailable);
    const list = yield* host
      .listIssues({ cwd: host.cwd })
      .pipe(Effect.catch(hostFailure("list read", projectId)));
    return { ...list, unavailable: null, readAt } satisfies IssueList;
  });

  // Concurrent reads of one project share a host request, and answers are shared for a while.
  // Failures are dropped at once so a fixed credential or network shows on the next read.
  const listCache = yield* Cache.makeWith(listUncached, {
    capacity: LIST_CACHE_CAPACITY,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LIST_CACHE_TTL : Duration.zero),
  });

  const unsupported = new IssueOperationError({
    reason: "This project's host does not support that for issues.",
  });

  const get = Effect.fn("IssueService.get")(function* (projectId: ProjectId, number: number) {
    const { cwd, provider } = yield* requireIssueHost(projectId);
    if (provider.getIssue === undefined) return yield* unsupported;
    const detail = yield* provider
      .getIssue({ cwd, number })
      .pipe(Effect.catch(hostFailure("read", projectId)));
    return { ...detail, readAt: DateTime.formatIso(yield* DateTime.now) };
  });

  const create: IssueService["Service"]["create"] = Effect.fn("IssueService.create")(
    function* (input) {
      const { cwd, provider } = yield* requireIssueHost(input.projectId);
      if (provider.createIssue === undefined) return yield* unsupported;
      const issue = yield* provider
        .createIssue({ cwd, title: input.title, body: input.body })
        .pipe(Effect.catch(hostFailure("create", input.projectId)));
      yield* Cache.invalidate(listCache, input.projectId);
      return issue;
    },
  );

  const setState: IssueService["Service"]["setState"] = Effect.fn("IssueService.setState")(
    function* (input) {
      const { cwd, provider } = yield* requireIssueHost(input.projectId);
      if (provider.setIssueState === undefined) return yield* unsupported;
      const issue = yield* provider
        .setIssueState({
          cwd,
          number: input.number,
          state: input.state,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        })
        .pipe(Effect.catch(hostFailure("state change", input.projectId)));
      yield* Cache.invalidate(listCache, input.projectId);
      return issue;
    },
  );

  return IssueService.of({
    get,
    create,
    setState,
    // A reader can join a lookup still finishing a previous reader's cancellation.
    list: Effect.fn("IssueService.list")((projectId) =>
      Cache.get(listCache, projectId).pipe(
        Effect.catchCauseIf(Cause.hasInterruptsOnly, () => Cache.get(listCache, projectId)),
      ),
    ),
  });
});

export const layer = Layer.effect(IssueService, make);
