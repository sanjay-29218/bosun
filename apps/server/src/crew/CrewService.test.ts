// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  CAPTAIN_BOT_ID,
  CommandId,
  PROJECT_MANAGER_ROLE_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { CrewTestOrchestration, seedCrewProject } from "./CrewRuntime.testkit.ts";
import { OrchestratorDispatchError as OrchestrationCommandInvariantError } from "../orchestration-v2/Orchestrator.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as BotStore from "../bots/BotStore.ts";
import { CrewHandoffService } from "./CrewHandoffService.ts";
import {
  CrewService,
  CrewServiceLive,
  projectBuilderMemberId,
  projectManagerMemberId,
} from "./CrewService.ts";
import { WorkflowLibraryLive } from "../workflows/WorkflowLibrary.ts";
import { CrewStore, CrewStoreLive } from "./CrewStore.ts";
import { CrewThreadRuntime } from "./CrewThreadRuntime.ts";
import { CrewRuntimeLive } from "./runtimeLayer.ts";

const projectId = ProjectId.make("bot-test-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const withSystem = <A, E>(
  databasePath: string,
  use: (services: {
    readonly bots: CrewService["Service"];
    readonly store: CrewStore["Service"];
    readonly handoffs: CrewHandoffService["Service"];
    readonly engine: OrchestrationEngineService["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly query: {
      readonly getThreadDetailById: (threadId: ThreadId) => Effect.Effect<
        Option.Option<{
          readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
        }>,
        import("../orchestration-v2/Orchestrator.ts").OrchestratorV2Error
      >;
    };
  }) => Effect.Effect<A, E, ProjectStore.ProjectStoreV2>,
) => {
  const orchestration = CrewTestOrchestration;
  const layer = Layer.mergeAll(
    orchestration,
    CrewRuntimeLive.pipe(Layer.provide(orchestration)),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerFromPath(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-test-" })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* use({
      bots: yield* CrewService,
      store: yield* CrewStore,
      handoffs: yield* CrewHandoffService,
      engine,
      sql: yield* SqlClient.SqlClient,
      query: {
        getThreadDetailById: (threadId) =>
          engine.getThreadRecords(threadId, ["messages"]).pipe(Effect.asSome),
      },
    });
  }).pipe(Effect.provide(layer));
};

const createProject = (_engine: OrchestrationEngineService["Service"]) =>
  seedCrewProject({
    projectId,
    title: "Bot test project",
    workspaceRoot: "/tmp/bot-test-project",
  });

const createBot = (bots: CrewService["Service"]) =>
  bots.createMember({
    id: "execution-1",
    projectId,
    name: "Builder",
    instructions: "Implement the assigned change.",
    allowedTools: ["crew.delegate"],
    modelSelection,
    runtimeMode: "approval-required",
  });

describe("Bot foundation", () => {
  effectIt.effect("keeps custom roles, crew members, and hierarchy distinct", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-custom-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, engine }) =>
        Effect.gen(function* () {
          yield* createProject(engine);
          yield* Effect.all(
            [bots.ensureDefaults(modelSelection), bots.ensureDefaults(modelSelection)],
            { concurrency: 2 },
          );
          const defaultRoleIds = (yield* bots.listRoles()).map((role) => role.id);
          expect(new Set(defaultRoleIds).size).toBe(defaultRoleIds.length);
          expect(defaultRoleIds).toContain(PROJECT_MANAGER_ROLE_ID);
          const manager = yield* bots.ensureProjectManager(projectId);
          const role = yield* bots.createRole({
            id: "role:custom",
            name: "Researcher",
            instructions: "Research the assigned question.",
            modelSelection,
            runtimeMode: "approval-required",
            autoCreateForFeature: true,
          });
          const member = yield* bots.instantiate("bot:researcher", projectId, role.id);
          expect(member.roleId).toBe(role.id);
          expect(member.roleRevision).toBe(1);
          expect((yield* bots.getRole(role.id))?.autoCreateForFeature).toBe(true);
          const updatedRole = yield* bots.updateRole({
            ...role,
            name: "Investigator",
            instructions: "Investigate a question.",
            expectedRevision: role.revision,
            enabled: false,
          });
          expect(updatedRole.revision).toBe(2);
          expect((yield* bots.getMember(member.id))?.name).toBe("Researcher");
          expect(
            (yield* bots.instantiate("bot:second", projectId, role.id).pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* bots.setHierarchyParent(member.id, manager.id, 2);
          const hierarchy = yield* bots.listHierarchyForProject(projectId);
          expect(hierarchy.find((node) => node.memberId === member.id)).toMatchObject({
            parentMemberId: manager.id,
            position: 2,
          });
          // Captain is a top-level bot, not a crew member, so the manager is a hierarchy root.
          expect(hierarchy.find((node) => node.memberId === manager.id)?.parentMemberId).toBeNull();
          expect(
            (yield* bots.setHierarchyParent(manager.id, member.id).pipe(Effect.result))._tag,
          ).toBe("Failure");
          expect(
            (yield* bots
              .createMember({
                id: "bot:wrong-scope",
                projectId: null,
                roleId: role.id,
                name: "Wrong scope",
                instructions: "Invalid.",
                modelSelection,
                runtimeMode: "approval-required",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("completes a manager whose setup stopped on a disabled role", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-manager-partial-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, store, engine }) =>
        Effect.gen(function* () {
          yield* createProject(engine);
          yield* bots.ensureDefaults(modelSelection);
          const builderRole = (yield* store.getRole("role:builder"))!;
          const disabled = yield* bots.updateRole({
            ...builderRole,
            expectedRevision: builderRole.revision,
            enabled: false,
          });
          const failed = yield* Effect.exit(bots.ensureProjectManager(projectId));
          expect(failed._tag).toBe("Failure");
          // The manager was made; the builder and its grant were not.
          expect(yield* store.getMember(projectManagerMemberId(projectId))).not.toBeNull();
          expect(yield* store.getMember(projectBuilderMemberId(projectId))).toBeNull();

          yield* bots.updateRole({
            ...disabled,
            expectedRevision: disabled.revision,
            enabled: true,
          });
          const manager = yield* bots.ensureProjectManager(projectId);
          expect(yield* store.getMember(projectBuilderMemberId(projectId))).not.toBeNull();
          expect(
            yield* store.canDelegate(manager.id, projectBuilderMemberId(projectId), projectId),
          ).toBe(true);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("creates a project's manager once, and its owning bot may delegate to it", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-manager-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, store, engine }) =>
        Effect.gen(function* () {
          yield* createProject(engine);
          yield* bots.ensureDefaults(modelSelection);
          expect(yield* store.getMember(CAPTAIN_BOT_ID)).toBeNull();
          expect(yield* store.getMember(projectManagerMemberId(projectId))).toBeNull();
          const first = yield* bots.ensureProjectManager(projectId);
          const second = yield* bots.ensureProjectManager(projectId);
          expect(first.id).toBe(projectManagerMemberId(projectId));
          expect(first.roleId).toBe(PROJECT_MANAGER_ROLE_ID);
          expect(second).toEqual(first);
          const members = (yield* store.listMembersForProject(projectId)).filter(
            (member) => member.projectId === projectId,
          );
          expect(members.map((member) => member.id).toSorted()).toEqual(
            [projectBuilderMemberId(projectId), projectManagerMemberId(projectId)].toSorted(),
          );
          expect(yield* store.canDelegate(CAPTAIN_BOT_ID, first.id, projectId)).toBe(true);
          expect(
            yield* store.canDelegate(first.id, projectBuilderMemberId(projectId), projectId),
          ).toBe(true);
          // Captain's permission follows from owning the project, not a stored grant.
          expect(
            (yield* store.listDelegationGrantsForProject(projectId)).map(
              (grant) => grant.sourceMemberId,
            ),
          ).not.toContain(CAPTAIN_BOT_ID);
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("runs as the project's owning bot, which delegates to the manager", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-owner-")),
      );
      yield* withSystem(
        NodePath.join(directory, "state.sqlite"),
        ({ bots, store, handoffs, engine, sql }) =>
          Effect.gen(function* () {
            yield* createProject(engine);
            yield* bots.ensureDefaults(modelSelection);
            const request = yield* bots.startRequest({
              id: "owner-request",
              projectId,
              modelSelection,
              taskText: "Ship the change",
            });
            expect(request.memberId).toBe(CAPTAIN_BOT_ID);
            // Without a requested model, the run takes the one ensureDefaults gave Captain.
            const run = yield* bots.createRun({
              id: "owner-run",
              memberId: CAPTAIN_BOT_ID,
              projectId,
              taskText: "Coordinate",
            });
            expect(run.memberId).toBe(CAPTAIN_BOT_ID);
            expect(run.modelSelection).toEqual(modelSelection);
            const handoff = yield* handoffs.delegate({
              id: "owner-to-manager",
              sourceThreadId: run.threadId,
              targetMemberId: projectManagerMemberId(projectId),
              projectId,
              taskText: "Own the change",
            });
            expect(handoff.status).toBe("running");
            const grants = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM crew_delegation_grants
              WHERE source_member_id = ${CAPTAIN_BOT_ID}
            `;
            expect(grants[0]?.count).toBe(0);
            // Ownership covers the project's members only, not another project's.
            expect(
              yield* store.canDelegate(
                CAPTAIN_BOT_ID,
                projectManagerMemberId(projectId),
                ProjectId.make("other-project"),
              ),
            ).toBe(false);
          }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("keeps a bot's headquarters in a project it owns where Scratch is off", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-hq-")),
      );
      yield* withSystem(
        NodePath.join(directory, "state.sqlite"),
        ({ bots, handoffs, engine, sql }) =>
          Effect.gen(function* () {
            // A bot without a model has no headquarters.
            expect(
              (yield* bots.ensureHeadquarters(CAPTAIN_BOT_ID).pipe(Effect.flip)).message,
            ).toContain("Choose a default model for Captain");
            yield* bots.ensureDefaults(modelSelection);
            // No managed folders here, like a dev server whose data dir is inside a checkout.
            expect(
              (yield* bots.ensureHeadquarters(CAPTAIN_BOT_ID).pipe(Effect.flip)).message,
            ).toContain("Give Captain a project first");
            yield* createProject(engine);
            const headquarters = yield* bots.ensureHeadquarters(CAPTAIN_BOT_ID);
            expect(headquarters.projectId).toBe(projectId);
            expect(yield* bots.ensureHeadquarters(CAPTAIN_BOT_ID)).toEqual(headquarters);

            // Once its host project moves to another bot, it can no longer delegate there.
            const manager = yield* bots.ensureProjectManager(projectId);
            yield* sql`UPDATE projection_projects SET bot_id = 'bot-elsewhere'`;
            expect(
              (yield* handoffs
                .delegate({
                  id: "hq-after-move",
                  sourceThreadId: headquarters.threadId,
                  targetMemberId: manager.id,
                  taskText: "Keep going",
                })
                .pipe(Effect.flip)).message,
            ).toContain("unavailable for this project");
            yield* sql`UPDATE projection_projects SET bot_id = ${CAPTAIN_BOT_ID}`;

            // Deleting the project it lives in sends it looking for another home.
            yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-14T00:00:00.000Z'`;
            expect(
              (yield* bots.ensureHeadquarters(CAPTAIN_BOT_ID).pipe(Effect.flip)).message,
            ).toContain("Give Captain a project first");
          }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("refuses new runs for a bot after its project moves, but keeps old ones", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-move-")),
      );
      yield* withSystem(
        NodePath.join(directory, "state.sqlite"),
        ({ bots, store, handoffs, engine, sql }) =>
          Effect.gen(function* () {
            yield* createProject(engine);
            yield* bots.ensureDefaults(modelSelection);
            const manager = yield* bots.ensureProjectManager(projectId);
            const before = yield* bots.createRun({
              id: "captain-before-move",
              memberId: CAPTAIN_BOT_ID,
              projectId,
              taskText: "Coordinate before the move",
            });
            yield* sql`
              INSERT INTO bots (
                id, name, avatar_json, color, instructions, allowed_tools_json, runtime_mode,
                model_selection_json, default_workflow_id, position, revision, created_at,
                updated_at
              ) VALUES (
                'bot-second', 'Second',
                '{"head":"round","eyes":"round","face":"visor","top":"ball","cheeks":false,"smile":false}', 'blue', 'Coordinate.', '["crew.delegate"]',
                'approval-required', NULL, NULL, 1, 1, '2026-01-01', '2026-01-01'
              )
            `;
            yield* sql`UPDATE projection_projects SET bot_id = 'bot-second'
              WHERE project_id = ${projectId}`;

            const refused = yield* bots
              .createRun({
                id: "captain-after-move",
                memberId: CAPTAIN_BOT_ID,
                projectId,
                taskText: "Coordinate after the move",
              })
              .pipe(Effect.flip);
            expect(refused.message).toContain("doesn't own this project");
            // The new owner runs once it has a model.
            const unready = yield* bots
              .createRun({
                id: "second-run",
                memberId: "bot-second",
                projectId,
                taskText: "Coordinate",
              })
              .pipe(Effect.flip);
            expect(unready.message).toContain("Choose a default model for Second");
            expect(
              (yield* bots.startRequest({
                id: "second-request",
                projectId,
                modelSelection,
                taskText: "Ship it",
              })).memberId,
            ).toBe("bot-second");

            // A run started before the move still delegates on its project.
            expect(yield* store.canDelegate(CAPTAIN_BOT_ID, manager.id, before.projectId)).toBe(
              true,
            );
            const handoff = yield* handoffs.delegate({
              id: "old-run-to-manager",
              sourceThreadId: before.threadId,
              targetMemberId: manager.id,
              projectId,
              taskText: "Finish the earlier request",
            });
            expect(handoff.status).toBe("running");
          }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("retains a failed dispatch and retries it without a new run", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fakeRuntime = Layer.succeed(CrewThreadRuntime, {
        projectExists: () => Effect.succeed(true),
        headquartersProjectId: Effect.succeed(null),
        restore: () => Effect.void,
        syncSettings: () => Effect.void,
        settings: () => Effect.succeed(null),
        pin: () => Effect.void,
        start: () =>
          Effect.sync(() => ++attempts).pipe(
            Effect.flatMap((attempt) =>
              attempt === 1
                ? Effect.fail(
                    new OrchestrationCommandInvariantError({
                      commandType: "thread.create",
                      commandId: CommandId.make("test-failure"),
                      cause: new Error("test failure"),
                    }),
                  )
                : Effect.void,
            ),
          ),
        getTurnState: () => Effect.succeed("pending" as const),
        replayPending: () => Effect.void,
        notify: () => Effect.void,
        interrupt: () => Effect.void,
        listPendingStartedRunIds: () => Effect.succeed([]),
      });
      const layer = CrewServiceLive.pipe(
        Layer.provideMerge(CrewStoreLive),
        Layer.provideMerge(BotStore.layer),
        Layer.provideMerge(WorkflowLibraryLive),
        Layer.provide(fakeRuntime),
        Layer.provide(SqlitePersistence.layerMemory),
      );
      yield* Effect.gen(function* () {
        const bots = yield* CrewService;
        const bot = yield* bots.createMember({
          id: "retry-bot",
          projectId,
          name: "Retry bot",
          instructions: "Try this task.",
          modelSelection,
          runtimeMode: "approval-required",
        });
        const first = yield* bots
          .createRun({
            id: "retry-run",
            memberId: bot.id,
            projectId,
            taskText: "Retry after failure",
          })
          .pipe(Effect.result);
        expect(first._tag).toBe("Failure");
        const queued = yield* bots.getRun("retry-run");
        expect(queued?.run.dispatchState).toBe("queued");
        expect(queued?.run.lastError).toContain("retry pending");
        yield* bots.reconcileRuns();
        const resumed = yield* bots.getRun("retry-run");
        expect(resumed?.run.dispatchState).toBe("started");
        expect(resumed?.run.lastError).toBeNull();
        expect(attempts).toBe(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  effectIt.effect("links a bot run to one T3 thread and replays without a second turn", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-run-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      yield* withSystem(databasePath, ({ bots, engine, query, sql }) =>
        Effect.gen(function* () {
          yield* createProject(engine);
          yield* createBot(bots);
          const request = {
            id: "run-1",
            memberId: "execution-1",
            projectId,
            taskText: "Add the small change",
          };
          const first = yield* bots.createRun(request);
          const replay = yield* bots.createRun(request);
          const detail = yield* query.getThreadDetailById(first.threadId);
          expect(first.dispatchState).toBe("started");
          expect(first.allowedTools).toEqual(["crew.delegate"]);
          expect(first.memberRevision).toBe(1);
          expect(replay.threadId).toBe(first.threadId);
          const conflicting = yield* bots
            .createRun({ ...request, taskText: "Another task" })
            .pipe(Effect.flip);
          expect(conflicting.message).toContain("Run ID belongs to another request");
          expect(detail._tag).toBe("Some");
          if (detail._tag === "Some") {
            expect(detail.value.messages.filter((message) => message.role === "user")).toHaveLength(
              1,
            );
            expect(detail.value.messages[0]?.text).toContain("Implement the assigned change.");
          }
          const view = yield* bots.getRun("run-1");
          expect(view?.run.threadId).toBe(ThreadId.make("bot-run:run-1"));
          const summaries = yield* bots.listRunSummaries(projectId, 1);
          expect(summaries).toHaveLength(1);
          expect(summaries[0]).not.toHaveProperty("taskText");
          expect(summaries[0]).not.toHaveProperty("instructions");
          yield* sql`UPDATE crew_runs SET thread_id = 'bot-run:legacy' WHERE id = 'run-1'`;
          yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at)
            VALUES ('bot-run:legacy', '2026-01-01', '2026-01-01')`;
          yield* bots.reconcileRuns();
          expect((yield* bots.getRun("run-1"))?.turnState).toBe("completed");
          expect((yield* bots.listRunSummaries(projectId, 1))[0]?.turnState).toBe("completed");
          expect((yield* bots.getRun("run-1"))?.run.recoveryAttempt).toBe(0);
          expect(yield* engine.getThreadShell(ThreadId.make("bot-run:legacy"))).toBeNull();
        }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect("recovers a persisted queued run after restart", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-restart-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      yield* Effect.gen(function* () {
        yield* withSystem(databasePath, ({ bots, store, engine }) =>
          Effect.gen(function* () {
            yield* createProject(engine);
            const bot = yield* createBot(bots);
            yield* store.insertRun({
              id: "queued-1",
              memberId: bot.id,
              projectId,
              threadId: ThreadId.make("bot-run:queued-1"),
              taskText: "Recover this task",
              title: "Builder: Recover this task",
              instructions: bot.instructions,
              allowedTools: bot.allowedTools,
              memberRevision: bot.revision,
              modelSelection: bot.modelSelection,
              runtimeMode: bot.runtimeMode,
              dispatchState: "queued",
              recoveryAttempt: 0,
              lastError: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              dispatchedAt: null,
            });
            // Simulate a crash after T3 accepted thread creation but before turn start.
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("bot-run:queued-1:create"),
              threadId: ThreadId.make("bot-run:queued-1"),
              projectId,
              title: "Builder: Recover this task",
              modelSelection: bot.modelSelection,
              runtimeMode: bot.runtimeMode,
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "agent",
              creationSource: "mcp",
            });
          }),
        );
        yield* withSystem(databasePath, ({ bots, query }) =>
          Effect.gen(function* () {
            yield* bots.reconcileRuns();
            const recovered = yield* bots.getRun("queued-1");
            const detail = yield* query.getThreadDetailById(ThreadId.make("bot-run:queued-1"));
            expect(recovered?.run.dispatchState).toBe("started");
            expect(detail._tag).toBe("Some");
            if (detail._tag === "Some") {
              expect(
                detail.value.messages.filter((message) => message.role === "user"),
              ).toHaveLength(1);
            }
          }),
        );
        yield* withSystem(databasePath, ({ bots, query }) =>
          Effect.gen(function* () {
            yield* bots.reconcileRuns();
            const replayed = yield* bots.getRun("queued-1");
            const detail = yield* query.getThreadDetailById(ThreadId.make("bot-run:queued-1"));
            expect(replayed?.run.recoveryAttempt).toBe(0);
            expect(detail._tag).toBe("Some");
            if (detail._tag === "Some") {
              expect(
                detail.value.messages.filter((message) => message.role === "user"),
              ).toHaveLength(1);
            }
          }),
        );
      }).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
