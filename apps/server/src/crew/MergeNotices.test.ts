import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  ProjectId,
  projectHeadquartersRunId,
  projectHeadquartersThreadId,
  ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import { FeatureService } from "../features/FeatureService.ts";
import * as NoticeInbox from "../features/NoticeInbox.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as BosunMigrations from "../persistence/BosunMigrations.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { CrewStore } from "./CrewStore.ts";
import * as MergeNotices from "./MergeNotices.ts";

const web = ProjectId.make("project:web");
const docs = ProjectId.make("project:docs");
const merged = (mergedAt = "2026-11-05T12:00:00.000Z"): ThreadPullRequestLink => ({
  host: "github.com",
  repository: "acme/web",
  number: 12,
  url: "https://github.com/acme/web/pull/12",
  source: "agent",
  linkedAt: "2026-11-05T00:00:00.000Z",
  snapshot: {
    state: "merged",
    title: "CSV export",
    headBranch: "bosun/csv",
    baseBranch: "staging",
    isDraft: false,
    updatedAt: mergedAt,
    closedAt: mergedAt,
    mergedAt,
    syncedAt: mergedAt,
  },
  stack: null,
});

const thread = (
  id: string,
  projectId: ProjectId,
  fields: Partial<ProjectionStore.ProjectionThreadPullRequests> = {},
): ProjectionStore.ProjectionThreadPullRequests => ({
  id: ThreadId.make(id),
  projectId,
  title: id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  settledOverride: null,
  settledAt: null,
  archivedAt: null,
  feature: null,
  issue: null,
  pullRequests: [merged()],
  ...fields,
});
const csv = { id: "feature:csv", title: "CSV export" };
const threads = [
  thread("web-lead", web, { feature: csv }),
  // The feature's crew shares its pull request; the feature is named once.
  thread("web-builder", web, { feature: { ...csv, member: "Builder" } }),
  thread("web-task", web, {
    title: "R-2: Docs for CSV",
    lineage: {
      parentThreadId: projectHeadquartersThreadId(web),
      relationshipToParent: "subagent",
      rootThreadId: projectHeadquartersThreadId(web),
    },
    issue: {
      url: "https://github.com/acme/web/issues/15",
      number: 15,
      title: "Docs",
      state: "open",
      milestone: "Exports",
      subIssues: null,
    },
  }),
  // A person's own thread with the pull request is no project work to report.
  thread("web-plain", web),
  thread("docs-lead", docs, { feature: { id: "feature:docs", title: "Docs site" } }),
];

/** The service over a migrated database; each project's manager started at `managersFrom`. */
const setup = (managersFrom = "2026-11-01T00:00:00.000Z") =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
    const layer = MergeNotices.layer.pipe(
      Layer.provideMerge(NoticeInbox.layer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Ref.update(dispatched, (all) => [...all, command]).pipe(Effect.as({} as never)),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadsWithPullRequests: (threadId) =>
              Effect.succeed(
                threadId === undefined ? threads : threads.filter((each) => each.id === threadId),
              ),
          }),
          Layer.mock(FeatureService)({
            get: (id) =>
              Effect.succeed(
                id === csv.id
                  ? ({
                      id,
                      number: 3,
                      issue: {
                        url: "https://github.com/acme/web/issues/14",
                        number: 14,
                        title: "CSV",
                        state: "open",
                        milestone: "Exports",
                        subIssues: null,
                      },
                    } as never)
                  : ({ id, number: 1, issue: null } as never),
              ),
          }),
          Layer.mock(CrewStore)({
            getRun: (id) =>
              Effect.succeed(
                id === projectHeadquartersRunId(web) || id === projectHeadquartersRunId(docs)
                  ? ({
                      dispatchState: "started",
                      threadId: projectHeadquartersThreadId(id.slice("project-hq:".length)),
                      createdAt: managersFrom,
                    } as never)
                  : null,
              ),
          }),
        ),
      ),
    );
    const { notices, inbox } = yield* Effect.all({
      notices: MergeNotices.MergeNotices,
      inbox: NoticeInbox.NoticeInbox,
    }).pipe(Effect.provide(layer));
    const sent = Ref.get(dispatched).pipe(
      Effect.map((all) =>
        all.flatMap((command) =>
          command.type === "message.dispatch"
            ? [{ threadId: command.threadId, id: command.messageId, text: command.text }]
            : [],
        ),
      ),
    );
    return { notices, inbox, sent };
  });

const migrated = Effect.gen(function* () {
  yield* runMigrations({ toMigrationInclusive: 79 });
  yield* BosunMigrations.reconcileLegacyHistory();
  yield* BosunMigrations.runMigrations();
});
const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });

it.effect("tells each project's manager once about a merge its work tracks", () =>
  Effect.gen(function* () {
    yield* migrated;
    const { notices, sent } = yield* setup();
    for (const id of ["web-lead", "web-builder", "web-task", "web-plain", "docs-lead"]) {
      yield* notices.handleLink(ThreadId.make(id), merged());
    }

    const messages = yield* sent;
    assert.deepStrictEqual(
      messages.map((message) => [message.threadId, message.id]),
      [
        [
          projectHeadquartersThreadId(web),
          "message:project-merge:project:web:github.com/acme/web#12",
        ],
        [
          projectHeadquartersThreadId(docs),
          "message:project-merge:project:docs:github.com/acme/web#12",
        ],
      ],
    );
    const [notice] = messages;
    assert.include(notice!.text, "merged into staging");
    assert.include(notice!.text, 'Feature "CSV export" (F-3): issue #14, milestone Exports');
    assert.include(notice!.text, 'Task "R-2: Docs for CSV"');
    assert.include(notice!.text, "issue #15, milestone Exports");
    assert.strictEqual(notice!.text.match(/Feature "CSV export"/g)?.length, 1);
    assert.notInclude(notice!.text, "web-plain");
  }).pipe(Effect.provide(sqlite)),
);

it.effect("tells a busy manager about a merge with its other notices once it is free", () =>
  Effect.gen(function* () {
    yield* migrated;
    const { notices, inbox, sent } = yield* setup();
    const sql = yield* SqlClient.SqlClient;
    const manager = projectHeadquartersThreadId(web);
    const managerTurn = (status: string) => sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:manager', ${manager}, 1, 'codex', ${status}, '2026-11-05T00:00:00.000Z', '{}')
      ON CONFLICT (run_id) DO UPDATE SET status = excluded.status
    `;
    yield* managerTurn("running");
    yield* notices.handleLink(ThreadId.make("web-lead"), merged());
    yield* inbox.post({ threadId: manager, key: "request-reply", text: "R-4 is done." });
    assert.deepStrictEqual(yield* sent, []);
    yield* managerTurn("completed");
    yield* inbox.flush(manager);
    const messages = yield* sent;
    assert.lengthOf(messages, 1);
    assert.match(messages[0]!.text, /^2 updates arrived[^]*acme\/web#12[^]*R-4 is done/);
  }).pipe(Effect.provide(sqlite)),
);

it.effect("sends nothing again after a restart, and reconciles missed merges since", () =>
  Effect.gen(function* () {
    yield* migrated;
    const first = yield* setup();
    yield* first.notices.handleLink(ThreadId.make("web-lead"), merged());

    // A restart: the same database, a new service, an event replayed and a reconcile.
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES
        (${projectHeadquartersRunId(web)}, 'project-manager:web', ${web},
          ${projectHeadquartersThreadId(web)}, 'Manage', 'Project manager', '', '[]', 1, '{}',
          'full-access', '2026-11-01T00:00:00.000Z'),
        (${projectHeadquartersRunId(docs)}, 'project-manager:docs', ${docs},
          ${projectHeadquartersThreadId(docs)}, 'Manage', 'Project manager', '', '[]', 1, '{}',
          'full-access', '2026-11-01T00:00:00.000Z')
    `;
    const restarted = yield* setup();
    yield* restarted.notices.handleLink(ThreadId.make("web-lead"), merged());
    yield* restarted.notices.reconcile();
    // The docs project missed its merge while the server was down; web already heard.
    assert.deepStrictEqual(
      (yield* restarted.sent).map((message) => message.threadId),
      [projectHeadquartersThreadId(docs)],
    );
  }).pipe(Effect.provide(sqlite)),
);

it.effect("leaves merges from before a project's manager existed out of its reconcile", () =>
  Effect.gen(function* () {
    yield* migrated;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO crew_runs (id, member_id, project_id, thread_id, task_text, title, instructions,
        allowed_tools_json, member_revision, model_selection_json, runtime_mode, created_at)
      VALUES (${projectHeadquartersRunId(web)}, 'project-manager:web', ${web},
        ${projectHeadquartersThreadId(web)}, 'Manage', 'Project manager', '', '[]', 1, '{}',
        'full-access', '2026-11-06T00:00:00.000Z')
    `;
    const { notices, sent } = yield* setup("2026-11-06T00:00:00.000Z");
    yield* notices.reconcile();
    assert.deepStrictEqual(yield* sent, []);
  }).pipe(Effect.provide(sqlite)),
);
