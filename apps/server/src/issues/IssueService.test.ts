import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  SourceControlProviderError,
  SourceControlProviderKind,
  type RepositoryIssue,
} from "@t3tools/contracts";
import type * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as IssueService from "./IssueService.ts";

const projectId = ProjectId.make("project:issues");

const issue: RepositoryIssue = {
  number: 7,
  title: "Board shows issues",
  url: "https://github.com/acme/web/issues/7",
  state: "open",
  updatedAt: "2026-10-01T00:00:00Z",
  closedAt: null,
  milestone: null,
  parent: null,
  subIssues: null,
  labels: [],
  assignees: [],
};

const context = (kind: string, name: string) => ({
  provider: { kind: SourceControlProviderKind.make(kind), name, baseUrl: "https://example.com" },
  remoteName: "origin",
  remoteUrl: "git@example.com:acme/web.git",
});

/** The service over one project at `/repo`, whose remote resolves to `provider`. */
const serviceLayer = (handle: SourceControlProviderRegistry.SourceControlProviderHandle) =>
  IssueService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (id) =>
            Effect.succeed(
              id === projectId
                ? Option.some({ workspaceRoot: "/repo" } as ProjectStore.ProjectRow)
                : Option.none(),
            ),
        }),
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle: () => Effect.succeed(handle),
        }),
      ),
    ),
  );

const provider = (
  kind: string,
  listIssues?: SourceControlProvider.SourceControlProvider["Service"]["listIssues"],
) =>
  ({
    kind: SourceControlProviderKind.make(kind),
    ...(listIssues === undefined ? {} : { listIssues }),
  }) as SourceControlProvider.SourceControlProvider["Service"];

it.effect("says why a project whose host cannot list issues has none", () =>
  Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const list = yield* issues.list(projectId);
    assert.strictEqual(list.repository, null);
    assert.include(list.unavailable, "GitLab");
    assert.deepStrictEqual(list.issues, []);
  }).pipe(
    Effect.provide(
      serviceLayer({ provider: provider("gitlab"), context: context("gitlab", "GitLab") }),
    ),
  ),
);

it.effect("shares a project's read for a while, and drops failures at once", () => {
  let reads = 0;
  const listIssues: SourceControlProvider.SourceControlProvider["Service"]["listIssues"] = (
    input,
  ) =>
    Effect.suspend(() => {
      reads += 1;
      return reads === 1
        ? Effect.fail(
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("github"),
              operation: "listIssues",
              cwd: input.cwd,
              detail:
                "GitHub is not authenticated. Run `gh auth login` (or set GH_TOKEN) and retry.",
            }),
          )
        : Effect.succeed({
            repository: "acme/web",
            issues: [issue],
            milestones: [],
            truncated: true,
          });
    });
  return Effect.gen(function* () {
    const issues = yield* IssueService.IssueService;
    const failed = yield* Effect.flip(issues.list(projectId));
    assert.include(failed.reason, "gh auth login");

    const [first, second] = yield* Effect.all([issues.list(projectId), issues.list(projectId)], {
      concurrency: "unbounded",
    });
    assert.strictEqual(reads, 2);
    assert.strictEqual(first.repository, "acme/web");
    assert.strictEqual(first.unavailable, null);
    assert.isTrue(first.truncated);
    assert.deepStrictEqual(first.issues, [issue]);
    assert.strictEqual(second, first);

    yield* TestClock.adjust("31 seconds");
    yield* issues.list(projectId);
    assert.strictEqual(reads, 3);

    const missing = yield* Effect.flip(issues.list(ProjectId.make("project:missing")));
    assert.include(missing.reason, "not found");
  }).pipe(
    Effect.provide(
      serviceLayer({
        provider: provider("github", listIssues),
        context: context("github", "GitHub"),
      }),
    ),
  );
});
