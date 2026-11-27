// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  botHeadquartersRunId,
  botHeadquartersThreadId,
  CommandId,
  EnvironmentId,
  MessageId,
  projectHeadquartersRunId,
  projectHeadquartersThreadId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  CREW_TEST_BOT_HOMES,
  CrewTestOrchestration,
  makeCrewTestOrchestration,
  seedCrewProject,
  seedCrewTestBot,
  CREW_TEST_BOT_ID as CAPTAIN_ID,
} from "./CrewRuntime.testkit.ts";
import { OrchestratorDispatchError as OrchestrationCommandInvariantError } from "../orchestration-v2/Orchestrator.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as BotStore from "../bots/BotStore.ts";
import { CrewService, CrewServiceLive, linkedRequestMemberId } from "./CrewService.ts";
import { CrewStore, CrewStoreLive } from "./CrewStore.ts";
import { CrewThreadRuntime } from "./CrewThreadRuntime.ts";
import { freshStartRecords } from "./headquartersFreshStart.testkit.ts";
import { CrewRuntimeLive } from "./runtimeLayer.ts";

const projectId = ProjectId.make("bot-test-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

const withSystem = <A, E>(
  databasePath: string,
  use: (services: {
    readonly bots: CrewService["Service"];
    readonly store: CrewStore["Service"];
    readonly engine: OrchestrationEngineService["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly settings: ServerSettingsService["Service"];
    readonly runtime: CrewThreadRuntime["Service"];
    readonly query: {
      readonly getThreadDetailById: (threadId: ThreadId) => Effect.Effect<
        Option.Option<{
          readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
        }>,
        import("../orchestration-v2/Orchestrator.ts").OrchestratorV2Error
      >;
    };
  }) => Effect.Effect<A, E, ProjectStore.ProjectStoreV2 | SqlClient.SqlClient>,
  orchestration = CrewTestOrchestration,
) => {
  const layer = Layer.mergeAll(
    orchestration,
    CrewRuntimeLive.pipe(Layer.provide(orchestration)),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerFromPath(databasePath)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-test-" })),
    Layer.provideMerge(
      Layer.mock(ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId: EnvironmentId.make("crew-test-environment"),
          label: "Studio Mac",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      }),
    ),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    return yield* use({
      bots: yield* CrewService,
      store: yield* CrewStore,
      engine,
      sql: yield* SqlClient.SqlClient,
      settings: yield* ServerSettingsService,
      runtime: yield* CrewThreadRuntime,
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
    modelSelection,
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
          const defaultRoles = yield* bots.listRoles();
          const defaultRoleIds = defaultRoles.map((role) => role.id);
          expect(new Set(defaultRoleIds).size).toBe(defaultRoleIds.length);
          expect(defaultRoleIds).not.toContain("role:feature-manager");
          const manager = yield* bots.instantiate("bot:lead", projectId, "role:planner");
          const role = yield* bots.createRole({
            id: "role:custom",
            name: "Researcher",
            instructions: "Research the assigned question.",
            modelSelection,
          });
          const member = yield* bots.instantiate("bot:researcher", projectId, role.id);
          expect(member.roleId).toBe(role.id);
          expect(member.roleRevision).toBe(1);
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
          // Captain is a top-level bot, not a crew member, so a member with no parent is a root.
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

  effectIt.effect(
    "a linked request's member needs no role, is made once, and its owning bot may delegate to it",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-linked-member-")),
        );
        yield* withSystem(
          NodePath.join(directory, "state.sqlite"),
          ({ bots, store, engine, sql }) =>
            Effect.gen(function* () {
              yield* createProject(engine);
              expect(yield* bots.listRoles()).toEqual([]);
              const sentModel = { ...modelSelection, model: "gpt-5.4-mini" };
              const first = yield* bots.ensureLinkedRequestMember(projectId, sentModel);
              expect(first).toMatchObject({
                id: linkedRequestMemberId(projectId),
                roleId: null,
                modelSelection: sentModel,
              });
              expect(first.instructions).toContain(`Your project is ${projectId}.`);
              expect(yield* bots.ensureLinkedRequestMember(projectId, modelSelection)).toEqual(
                first,
              );
              expect(yield* store.canDelegate(CAPTAIN_ID, first.id, projectId)).toBe(true);
              // Captain's permission follows from owning the project, not a stored grant.
              expect(
                (yield* store.listDelegationGrantsForProject(projectId)).map(
                  (grant) => grant.sourceMemberId,
                ),
              ).not.toContain(CAPTAIN_ID);
              // One made from the Feature manager role before it went takes the built-in text.
              yield* sql`
              UPDATE crew_members SET name = 'Feature manager', instructions = 'Lead it.'
              WHERE id = ${first.id}
            `;
              const refreshed = yield* bots.ensureLinkedRequestMember(projectId, modelSelection);
              expect(refreshed).toMatchObject({
                name: first.name,
                instructions: first.instructions,
                revision: first.revision + 1,
              });
            }),
        ).pipe(
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
          ),
        );
      }),
  );

  effectIt.effect("runs as the project's owning bot, which may delegate to its manager", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-owner-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, store, engine, sql }) =>
        Effect.gen(function* () {
          yield* createProject(engine);
          yield* bots.ensureDefaults(modelSelection);
          // Without a requested model, the run takes the one ensureDefaults gave Captain.
          const run = yield* bots.createRun({
            id: "owner-run",
            memberId: CAPTAIN_ID,
            projectId,
            taskText: "Coordinate",
          });
          expect(run.memberId).toBe(CAPTAIN_ID);
          expect(run.modelSelection).toEqual(modelSelection);
          const grants = yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM crew_delegation_grants
              WHERE source_member_id = ${CAPTAIN_ID}
            `;
          expect(grants[0]?.count).toBe(0);
          // Ownership covers the project's members only, not another project's.
          expect(
            yield* store.canDelegate(
              CAPTAIN_ID,
              linkedRequestMemberId(projectId),
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

  effectIt.effect("keeps a bot's headquarters in its home, and moves one in once", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-hq-")),
      );
      const database = NodePath.join(directory, "state.sqlite");
      yield* withSystem(database, ({ bots, engine, sql, store, settings }) =>
        Effect.gen(function* () {
          yield* seedCrewTestBot;
          // A bot without a model opens on the default one, and fails only with no provider.
          expect((yield* bots.ensureHeadquarters(CAPTAIN_ID).pipe(Effect.flip)).message).toBe(
            "No provider is available to run Captain. Set one up in Settings.",
          );
          const fallbackModel = { instanceId: ProviderInstanceId.make("claude"), model: "haiku" };
          yield* settings.updateSettings({ defaultModelSelection: fallbackModel });
          const onDefault = yield* bots.ensureHeadquarters(CAPTAIN_ID);
          expect(onDefault.modelSelection).toEqual(fallbackModel);
          expect(
            yield* sql`SELECT 1 FROM bots WHERE id = ${CAPTAIN_ID} AND model_selection_json IS NULL`,
          ).toHaveLength(1);
          yield* bots.ensureDefaults(modelSelection);
          // A bot that owns no project still gets its headquarters, in its own home. Opening it
          // again leaves its thread's model alone; only an edit to the bot's model moves it.
          const headquarters = yield* bots.ensureHeadquarters(CAPTAIN_ID);
          expect(headquarters.threadId).toBe(onDefault.threadId);
          expect((yield* engine.getThreadShell(headquarters.threadId))?.modelSelection).toEqual(
            fallbackModel,
          );
          // Picked in its composer, the model sticks when it is opened again.
          yield* engine.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("test:hq-composer-model"),
            threadId: headquarters.threadId,
            modelSelection,
          });
          yield* bots.ensureHeadquarters(CAPTAIN_ID);
          expect((yield* engine.getThreadShell(headquarters.threadId))?.modelSelection).toEqual(
            modelSelection,
          );
          const home = headquarters.projectId;
          const workspaceRoot = `${CREW_TEST_BOT_HOMES}/${CAPTAIN_ID}`;
          const homeRow = yield* sql<{ readonly workspaceRoot: string; readonly botId: string }>`
            SELECT workspace_root AS "workspaceRoot", bot_id AS "botId" FROM projection_projects
            WHERE project_id = ${home}
          `;
          expect(homeRow).toEqual([{ workspaceRoot, botId: CAPTAIN_ID }]);
          // It opens pinned, with no turn: nothing runs until someone writes to it.
          expect(yield* engine.getThreadShell(headquarters.threadId)).toMatchObject({
            projectId: home,
            pinnedAt: expect.anything(),
          });
          const opened = yield* engine.getThreadRecords(headquarters.threadId, [
            "messages",
            "runs",
          ]);
          expect([opened.messages, opened.runs]).toEqual([[], []]);
          expect(yield* bots.ensureHeadquarters(CAPTAIN_ID)).toEqual(headquarters);
          // Homes never get a Project manager.
          expect((yield* bots.ensureProjectManager(home).pipe(Effect.flip)).message).toBe(
            "Scratch and bot homes have no Project manager",
          );

          // One that lives elsewhere, as in Scratch before bots had homes, moves in.
          yield* createProject(engine);
          yield* engine.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("test:hq-ask"),
            threadId: headquarters.threadId,
            messageId: MessageId.make("test:hq-ask"),
            text: "What's open?",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          // Its first turn ended (no effect worker runs in tests).
          const setRuns = (status: string) =>
            sql`UPDATE orchestration_v2_projection_runs SET status = ${status},
              payload_json = json_set(payload_json, '$.status', ${status})
              WHERE thread_id = ${headquarters.threadId}`;
          yield* setRuns("completed");
          yield* engine.dispatch({
            type: "thread.project.move",
            commandId: CommandId.make("test:hq-to-scratch"),
            threadId: headquarters.threadId,
            projectId,
          });
          yield* store.moveRun(headquarters.id, projectId);
          const messages = (yield* engine.getThreadRecords(headquarters.threadId, ["messages"]))
            .messages.length;
          const placed = Effect.all([
            store.getRun(headquarters.id).pipe(Effect.map((run) => run?.projectId)),
            engine
              .getThreadShell(headquarters.threadId)
              .pipe(Effect.map((shell) => shell?.projectId)),
          ]);
          // While it works, the move is refused and both stay where they are.
          yield* setRuns("running");
          yield* bots.rehomeHeadquarters();
          expect(yield* placed).toEqual([projectId, projectId]);
          // Once it's quiet, the next sweep moves both, and its conversation ends with the move.
          yield* setRuns("completed");
          yield* bots.rehomeHeadquarters();
          expect(yield* placed).toEqual([home, home]);
          expect(
            (yield* engine.getThreadRecords(headquarters.threadId, ["providerThreads"])).thread
              .activeProviderThreadId,
          ).toBeNull();
          const moves = yield* sql<{ readonly status: string }>`
            SELECT status FROM orchestration_command_receipts
            WHERE command_id LIKE ${`bot-home:${CAPTAIN_ID}:${projectId}:%`}
            ORDER BY accepted_at
          `;
          expect(moves.map((move) => move.status)).toEqual(["rejected", "accepted"]);
          // It starts no turn: its next turn is the person's.
          expect(
            (yield* engine.getThreadRecords(headquarters.threadId, ["messages"])).messages.length,
          ).toBe(messages);
          const sequence = yield* engine.getThreadEventSequence(headquarters.threadId);
          yield* bots.rehomeHeadquarters();
          expect(yield* engine.getThreadEventSequence(headquarters.threadId)).toBe(sequence);

          // A deleted home is made again, and the headquarters restored there.
          yield* sql`UPDATE projection_projects SET deleted_at = '2026-11-05T00:00:00.000Z'
            WHERE project_id = ${home}`;
          const restored = yield* bots.ensureHeadquarters(CAPTAIN_ID);
          expect(restored.projectId).not.toBe(home);
          expect(
            yield* sql`SELECT 1 FROM projection_projects
              WHERE project_id = ${restored.projectId} AND workspace_root = ${workspaceRoot}
                AND deleted_at IS NULL`,
          ).toHaveLength(1);
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
        ({ bots, store, engine, sql, settings }) =>
          Effect.gen(function* () {
            yield* createProject(engine);
            yield* bots.ensureDefaults(modelSelection);
            const manager = yield* bots.ensureLinkedRequestMember(projectId, modelSelection);
            const before = yield* bots.createRun({
              id: "captain-before-move",
              memberId: CAPTAIN_ID,
              projectId,
              taskText: "Coordinate before the move",
            });
            yield* sql`
              INSERT INTO bots (
                id, name, avatar_json, color, instructions, model_selection_json, position,
                revision, created_at, updated_at
              ) VALUES (
                'bot-second', 'Second',
                '{"head":"round","eyes":"round","face":"visor","top":"ball","cheeks":false,"smile":false}', 'blue', 'Coordinate.',
                NULL, 1, 1, '2026-01-01', '2026-01-01'
              )
            `;
            yield* sql`UPDATE projection_projects SET bot_id = 'bot-second'
              WHERE project_id = ${projectId}`;

            const refused = yield* bots
              .createRun({
                id: "captain-after-move",
                memberId: CAPTAIN_ID,
                projectId,
                taskText: "Coordinate after the move",
              })
              .pipe(Effect.flip);
            expect(refused.message).toContain("doesn't own this project");
            // The new owner, with no model and no provider to fall back on, can't run yet.
            const unready = yield* bots
              .createRun({
                id: "second-run",
                memberId: "bot-second",
                projectId,
                taskText: "Coordinate",
              })
              .pipe(Effect.flip);
            expect(unready.message).toBe(
              "No provider is available to run Second. Set one up in Settings.",
            );
            // Its project's manager falls back to the default model in Settings, and with none,
            // names the bot and its machine.
            const managed = ProjectId.make("second-project");
            yield* seedCrewProject({
              projectId: managed,
              title: "Second's project",
              workspaceRoot: "/tmp/second-project",
              botId: "bot-second",
            });
            expect((yield* bots.ensureProjectManager(managed).pipe(Effect.flip)).message).toBe(
              "Second on Studio Mac has no default model",
            );
            const fallbackModel = {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4-mini",
            };
            yield* settings.updateSettings({
              defaultModelSelection: fallbackModel,
            });
            const managerRun = yield* bots.ensureProjectManager(managed);
            expect(managerRun.modelSelection).toEqual(fallbackModel);
            expect((yield* engine.getThreadShell(managerRun.threadId))?.modelSelection).toEqual(
              fallbackModel,
            );
            // So does the bot itself.
            expect(
              (yield* bots.createRun({
                id: "second-default-run",
                memberId: "bot-second",
                projectId: managed,
                taskText: "Coordinate",
              })).modelSelection,
            ).toEqual(fallbackModel);
            expect(
              (yield* bots.createRun({
                id: "second-request",
                memberId: "bot-second",
                projectId,
                modelSelection,
                taskText: "Ship it",
              })).memberId,
            ).toBe("bot-second");

            // A run started before the move still delegates on its project.
            expect(yield* store.canDelegate(CAPTAIN_ID, manager.id, before.projectId)).toBe(true);
          }),
      ).pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );

  effectIt.effect.each(["retried", "cancelled from its link", "cancelled as it starts"] as const)(
    "retains a failed dispatch and, unless %s ends it first, retries it without a new run",
    (outcome) =>
      Effect.gen(function* () {
        let attempts = 0;
        // The retry's thread is being made; released once the run is cancelled meanwhile.
        const starting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted: Array<ThreadId> = [];
        const fakeRuntime = Layer.succeed(CrewThreadRuntime, {
          projectExists: () => Effect.succeed(true),
          projectRemoteManager: () => Effect.succeed(null),
          projectBotId: () => Effect.succeed(null),
          projectModelSelection: () => Effect.succeed(null),
          runModelSelection: (_projectId, chosen) =>
            Effect.succeed(chosen && { selection: chosen, notice: null, blocked: null }),
          noteModelFallback: () => Effect.void,
          archive: () => Effect.void,
          isHiddenProject: () => Effect.succeed(false),
          botHome: () => Effect.die("unused"),
          moveThread: () => Effect.die("unused"),
          restore: () => Effect.void,
          setModel: () => Effect.succeed(false),
          freshStartRecords: () => Effect.die("unused"),
          startFresh: () => Effect.void,
          pin: () => Effect.void,
          unpin: () => Effect.void,
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
                  : outcome === "cancelled as it starts"
                    ? Deferred.succeed(starting, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      )
                    : Effect.void,
              ),
            ),
          // Its thread exists once a dispatch got through.
          getTurnState: () =>
            Effect.succeed(attempts >= 2 ? ("pending" as const) : ("missing" as const)),
          replayPending: () => Effect.void,
          interrupt: (threadId) => Effect.sync(() => interrupted.push(threadId)),
          listPendingStartedRunIds: () => Effect.succeed([]),
        });
        const layer = CrewServiceLive.pipe(
          Layer.provideMerge(CrewStoreLive),
          Layer.provideMerge(BotStore.layer),
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
          if (outcome === "cancelled as it starts") {
            // Cancelled from its link after the retry's last check, while its thread is made:
            // the thread it made is stopped, since nothing would ever follow it.
            const reconciling = yield* bots.reconcileRuns().pipe(Effect.forkChild);
            yield* Deferred.await(starting);
            yield* bots.cancelQueuedRun("retry-run");
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(reconciling);
            expect(interrupted).toEqual([ThreadId.make("bot-run:retry-run")]);
            expect(yield* bots.getRun("retry-run")).toBeNull();
            return;
          }
          if (outcome === "cancelled from its link") {
            // A linked environment ended the request: the queued run never starts.
            expect(yield* bots.cancelQueuedRun("retry-run")).toMatchObject({ started: false });
            yield* bots.reconcileRuns();
            expect(yield* bots.getRun("retry-run")).toBeNull();
            expect(attempts).toBe(1);
            return;
          }
          yield* bots.reconcileRuns();
          const resumed = yield* bots.getRun("retry-run");
          expect(resumed?.run.dispatchState).toBe("started");
          expect(resumed?.run.lastError).toBeNull();
          expect(attempts).toBe(2);
          // Once started, cancelling leaves it as it is and says it started.
          expect(yield* bots.cancelQueuedRun("retry-run")).toMatchObject({ started: true });
          expect((yield* bots.getRun("retry-run"))?.run.dispatchState).toBe("started");
        }).pipe(Effect.provide(layer));
      }),
  );

  effectIt.effect("a member keeps its role's fallback model, and its runs try it first", () =>
    Effect.gen(function* () {
      const fallback = { instanceId: ProviderInstanceId.make("claude"), model: "claude-haiku-5-5" };
      const asked: Array<unknown> = [];
      const fakeRuntime = Layer.mock(CrewThreadRuntime)({
        projectExists: () => Effect.succeed(true),
        // The role's own model is out of usage here, so its fallback stands in.
        runModelSelection: (_projectId, chosen, roleFallback) =>
          Effect.sync(() => {
            asked.push(roleFallback);
            const selection = roleFallback ?? chosen;
            return selection && { selection, notice: null, blocked: null };
          }),
        noteModelFallback: () => Effect.void,
        start: () => Effect.void,
        getTurnState: () => Effect.succeed("pending" as const),
      });
      const layer = CrewServiceLive.pipe(
        Layer.provideMerge(CrewStoreLive),
        Layer.provideMerge(BotStore.layer),
        Layer.provide(fakeRuntime),
        Layer.provide(SqlitePersistence.layerMemory),
      );
      yield* Effect.gen(function* () {
        const crew = yield* CrewService;
        yield* crew.createRole({
          id: "role:reviewer-2",
          name: "Reviewer",
          instructions: "Review it.",
          modelSelection,
          fallbackModelSelection: fallback,
        });
        const member = yield* crew.instantiate("reviewer-member", projectId, "role:reviewer-2");
        expect(member.fallbackModelSelection).toEqual(fallback);

        // Clearing the role's fallback leaves the member as it was made.
        const role = (yield* crew.getRole("role:reviewer-2"))!;
        const cleared = yield* crew.updateRole({
          ...role,
          fallbackModelSelection: null,
          expectedRevision: role.revision,
        });
        expect(cleared.fallbackModelSelection).toBeNull();
        expect((yield* crew.getMember(member.id))?.fallbackModelSelection).toEqual(fallback);
        // An update that leaves the field out keeps it.
        const kept = yield* crew.updateRole({
          id: cleared.id,
          name: cleared.name,
          instructions: "Review it closely.",
          modelSelection,
          enabled: true,
          expectedRevision: cleared.revision,
        });
        expect(kept.fallbackModelSelection).toBeNull();

        yield* crew.createRun({
          id: "review-run",
          memberId: member.id,
          projectId,
          taskText: "Review",
        });
        expect(asked).toEqual([fallback]);
        expect((yield* crew.getRun("review-run"))?.run.modelSelection).toEqual(fallback);
      }).pipe(Effect.provide(layer));
    }),
  );

  effectIt.effect("starts a bot's headquarters or a project's manager over when asked", () =>
    Effect.gen(function* () {
      const checks = yield* Queue.unbounded<ThreadId>();
      const fresh = yield* Queue.unbounded<{
        readonly threadId: ThreadId;
        readonly key: string;
      }>();
      const fakeRuntime = Layer.succeed(CrewThreadRuntime, {
        projectExists: () => Effect.succeed(true),
        projectRemoteManager: () => Effect.succeed(null),
        projectBotId: () => Effect.succeed(null),
        projectModelSelection: () => Effect.succeed(null),
        runModelSelection: (_projectId, chosen) =>
          Effect.succeed(chosen && { selection: chosen, notice: null, blocked: null }),
        noteModelFallback: () => Effect.void,
        archive: () => Effect.void,
        isHiddenProject: () => Effect.succeed(false),
        botHome: () => Effect.die("unused"),
        moveThread: () => Effect.die("unused"),
        restore: () => Effect.void,
        setModel: () => Effect.succeed(false),
        freshStartRecords: (threadId) =>
          Queue.offer(checks, threadId).pipe(Effect.as(freshStartRecords())),
        startFresh: (input) => Queue.offer(fresh, input).pipe(Effect.asVoid),
        pin: () => Effect.void,
        unpin: () => Effect.void,
        start: () => Effect.void,
        getTurnState: () => Effect.succeed("pending" as const),
        replayPending: () => Effect.void,
        interrupt: () => Effect.void,
        listPendingStartedRunIds: () => Effect.succeed([]),
      });
      const layer = CrewServiceLive.pipe(
        Layer.provideMerge(CrewStoreLive),
        Layer.provideMerge(BotStore.layer),
        Layer.provide(fakeRuntime),
        Layer.provide(SqlitePersistence.layerMemory),
      );
      yield* Effect.gen(function* () {
        const crew = yield* CrewService;
        const store = yield* CrewStore;
        const botStore = yield* BotStore.BotStore;
        {
          const id = "bot-ops";
          yield* botStore.insert({
            id,
            name: id,
            avatar: {
              head: "round",
              face: "visor",
              eyes: "round",
              top: "none",
              cheeks: false,
              smile: true,
            },
            color: "blue",
            instructions: "Run my projects.",
            modelSelection,
            linkedEnvironmentIds: [],
            position: 1,
            revision: 1,
            createdAt: "2026-10-30T00:00:00.000Z",
            updatedAt: "2026-10-30T00:00:00.000Z",
          });
          yield* store.insertRun({
            id: botHeadquartersRunId(id),
            memberId: id,
            projectId,
            threadId: botHeadquartersThreadId(id),
            taskText: "Lead the bot's work.",
            title: id,
            instructions: "Run my projects.",
            memberRevision: 1,
            modelSelection,
            runtimeMode: "full-access",
            dispatchState: "started",
            recoveryAttempt: 0,
            lastError: null,
            createdAt: "2026-10-30T00:00:00.000Z",
            dispatchedAt: "2026-10-30T00:00:00.000Z",
            workspace: null,
          });
        }
        const headquarters = botHeadquartersThreadId("bot-ops");
        yield* crew.startNewSession(headquarters);
        expect(yield* Queue.take(fresh)).toMatchObject({ threadId: headquarters });

        // A project's manager starts over the same way.
        yield* store.insertMember({
          id: `project-manager:${projectId}`,
          projectId,
          featureId: null,
          roleId: null,
          roleRevision: null,
          name: "Project manager",
          instructions: "Manage the project.",
          modelSelection,
          fallbackModelSelection: null,
          enabled: true,
          icon: null,
          customizedAt: null,
          revision: 1,
          createdAt: "2026-10-30T00:00:00.000Z",
          updatedAt: "2026-10-30T00:00:00.000Z",
        });
        const managerThreadId = projectHeadquartersThreadId(projectId);
        yield* store.insertRun({
          id: projectHeadquartersRunId(projectId),
          memberId: `project-manager:${projectId}`,
          projectId,
          threadId: managerThreadId,
          taskText: "Manage the project.",
          title: "Project manager",
          instructions: "Manage the project.",
          memberRevision: 1,
          modelSelection,
          runtimeMode: "full-access",
          dispatchState: "started",
          recoveryAttempt: 0,
          lastError: null,
          createdAt: "2026-10-30T00:00:00.000Z",
          dispatchedAt: "2026-10-30T00:00:00.000Z",
          workspace: null,
        });
        yield* crew.startNewSession(managerThreadId);
        const manual = yield* Queue.take(fresh);
        expect(manual).toMatchObject({ threadId: managerThreadId });
        expect(manual.key).toMatch(/^manual:/);
        expect(yield* Queue.size(fresh)).toBe(0);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );

  effectIt.effect.each([
    [
      "isn't signed in",
      { auth: { status: "unauthenticated" as const } },
      "Codex isn't signed in here",
    ],
    [
      "is out of usage",
      {
        usageLimits: {
          checkedAt: "1970-01-01T00:00:00.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 100 }],
        },
      },
      "Codex is out of usage",
    ],
  ] as const)(
    "runs a crew member and a bot on the fallback model while their provider %s",
    ([_name, codexState, reason]) =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-fallback-")),
        );
        // A second Codex account, as the test environment runs only Codex.
        const fallbackModel = {
          instanceId: ProviderInstanceId.make("codex_alternate"),
          model: "gpt-5.4-mini",
        };
        const provider = (instanceId: string, driver: string) =>
          ({
            instanceId: ProviderInstanceId.make(instanceId),
            driver: ProviderDriverKind.make(driver),
            displayName: instanceId === "codex" ? "Codex" : "Codex (work)",
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated" },
            checkedAt: "1970-01-01T00:00:00.000Z",
            models: [],
            slashCommands: [],
            skills: [],
          }) satisfies ServerProvider;
        const orchestration = makeCrewTestOrchestration({
          providers: [
            { ...provider("codex", "codex"), ...codexState },
            provider("codex_alternate", "codex"),
          ],
        });
        yield* withSystem(
          NodePath.join(directory, "state.sqlite"),
          ({ bots, engine, settings, store, runtime }) =>
            Effect.gen(function* () {
              yield* createProject(engine);
              yield* createBot(bots);
              yield* settings.updateSettings({
                fallbackModelSelection: fallbackModel,
                providerInstances: {
                  [fallbackModel.instanceId]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                    config: {},
                  },
                },
              });
              const run = yield* bots.createRun({
                id: "fallback-run",
                memberId: "execution-1",
                projectId,
                taskText: "Add the small change",
              });
              expect(run.modelSelection).toEqual(fallbackModel);
              expect((yield* engine.getThreadShell(run.threadId))?.modelSelection).toEqual(
                fallbackModel,
              );
              // Per run: the member keeps its own model for when Codex can run again.
              expect((yield* store.getMember("execution-1"))?.modelSelection).toEqual(
                modelSelection,
              );
              const { turnItems } = yield* engine.getThreadRecords(run.threadId, ["turnItems"]);
              expect(turnItems).toContainEqual(
                expect.objectContaining({
                  type: "system_notice",
                  title: "Using gpt-5.4-mini",
                  message: `${reason}, so this run uses the fallback model instead of gpt-5.4.`,
                }),
              );
              // With no fallback that can run either, it still starts, and its thread says why.
              yield* settings.updateSettings({ fallbackModelSelection: modelSelection });
              const blocked = yield* bots.createRun({
                id: "blocked-run",
                memberId: "execution-1",
                projectId,
                taskText: "Add another small change",
              });
              expect(blocked.modelSelection).toEqual(modelSelection);
              const blockedItems = yield* engine.getThreadRecords(blocked.threadId, ["turnItems"]);
              expect(blockedItems.turnItems).toContainEqual(
                expect.objectContaining({
                  type: "system_notice",
                  title: "No model can run",
                  level: "error",
                }),
              );
              // A notice that this run uses the fallback never lands on a run that doesn't.
              yield* runtime.noteModelFallback(blocked.threadId, fallbackModel, {
                title: "Using gpt-5.4-mini",
                message: "Not this run.",
              });
              expect(
                (yield* engine.getThreadRecords(blocked.threadId, ["turnItems"])).turnItems,
              ).not.toContainEqual(expect.objectContaining({ message: "Not this run." }));
              // Codex turned off for good: the launch is refused, and who asked hears why.
              yield* settings.updateSettings({
                providerInstances: {
                  [fallbackModel.instanceId]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                    config: {},
                  },
                  [modelSelection.instanceId]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: false,
                    config: {},
                  },
                },
              });
              const refused = yield* bots
                .createRun({
                  id: "disabled-run",
                  memberId: "execution-1",
                  projectId,
                  taskText: "Add a third small change",
                })
                .pipe(Effect.flip);
              expect(refused.message).toBe(
                "gpt-5.4 (codex) can't run: Codex is turned off here. The fallback model, gpt-5.4 (codex), can't run either: Codex is turned off here.",
              );
              // Nothing is left queued for recovery to start once Codex is back.
              expect(yield* store.getRun("disabled-run")).toBeNull();
              yield* settings.updateSettings({
                fallbackModelSelection: fallbackModel,
                providerInstances: {
                  [fallbackModel.instanceId]: {
                    driver: ProviderDriverKind.make("codex"),
                    enabled: true,
                    config: {},
                  },
                },
              });
              // A bot's headquarters follows the same rule each time it opens.
              yield* seedCrewTestBot;
              yield* bots.ensureDefaults(modelSelection);
              const headquarters = yield* bots.ensureHeadquarters(CAPTAIN_ID);
              expect((yield* engine.getThreadShell(headquarters.threadId))?.modelSelection).toEqual(
                fallbackModel,
              );
            }),
          orchestration,
        ).pipe(
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
          ),
        );
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
          expect(first.runtimeMode).toBe("full-access");
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
          yield* sql`UPDATE crew_runs SET thread_id = 'bot-run:legacy' WHERE id = 'run-1'`;
          yield* sql`INSERT INTO orchestration_v2_legacy_imports (thread_id, source_updated_at, shell_imported_at)
            VALUES ('bot-run:legacy', '2026-01-01', '2026-01-01')`;
          yield* bots.reconcileRuns();
          expect((yield* bots.getRun("run-1"))?.turnState).toBe("completed");
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

  effectIt.effect(
    "opens runs in their worktree, only the first runs setup, and one can make it",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-worktree-")),
        );
        const setups = yield* Queue.unbounded<ThreadId>();
        const checkouts = yield* Queue.unbounded<{
          refName: string;
          newRefName?: string | undefined;
        }>();
        const orchestration = makeCrewTestOrchestration({
          runSetup: (input) =>
            Queue.offer(setups, ThreadId.make(input.threadId)).pipe(
              Effect.as({ status: "no-script" as const }),
            ),
          createWorktree: (input) =>
            Queue.offer(checkouts, { refName: input.refName, newRefName: input.newRefName }).pipe(
              Effect.as({
                worktree: { path: "/worktrees/lead", refName: input.newRefName! },
              } as never),
            ),
        });
        yield* withSystem(
          NodePath.join(directory, "state.sqlite"),
          ({ bots, engine }) =>
            Effect.gen(function* () {
              yield* createProject(engine);
              yield* createBot(bots);
              const workspace = { branch: "bosun/board-1a2b3c", worktreePath: "/worktrees/board" };
              const run = (id: string) =>
                bots.createRun({ id, memberId: "execution-1", projectId, taskText: id, workspace });
              const plan = yield* run("plan");
              expect(yield* Queue.take(setups)).toBe(plan.threadId);
              const build = yield* run("build");
              // Setup runs before the launch releases the run, so a released run had its chance.
              const released = yield* engine
                .streamStoredEventsFrom({ threadId: build.threadId, eventType: "run.updated" })
                .pipe(
                  Stream.filterMap((stored) =>
                    stored.event.type === "run.updated" &&
                    stored.event.payload.status !== "preparing"
                      ? Result.succeed(stored.event.payload.status)
                      : Result.failVoid,
                  ),
                  Stream.runHead,
                );
              expect(released).toEqual(Option.some("starting"));
              expect(yield* Queue.size(setups)).toBe(0);
              for (const threadId of [plan.threadId, build.threadId]) {
                expect(yield* engine.getThreadShell(threadId)).toMatchObject(workspace);
              }
              // A run that names only a branch and its base has its thread check the worktree out.
              const lead = yield* bots.createRun({
                id: "lead",
                memberId: "execution-1",
                projectId,
                taskText: "lead",
                workspace: { branch: "bosun/lead-1a2b3c", baseRef: "main" },
              });
              expect(lead.workspace).toEqual({ branch: "bosun/lead-1a2b3c", baseRef: "main" });
              expect(yield* Queue.take(checkouts)).toEqual({
                refName: "main",
                newRefName: "bosun/lead-1a2b3c",
              });
              expect(yield* Queue.take(setups)).toBe(lead.threadId);
              expect(yield* engine.getThreadShell(lead.threadId)).toMatchObject({
                branch: "bosun/lead-1a2b3c",
                worktreePath: "/worktrees/lead",
              });
            }),
          orchestration,
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
              memberRevision: bot.revision,
              modelSelection: bot.modelSelection,
              runtimeMode: "full-access",
              dispatchState: "queued",
              recoveryAttempt: 0,
              lastError: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              dispatchedAt: null,
              workspace: null,
            });
            // Simulate a crash after T3 accepted thread creation but before turn start.
            yield* engine.dispatch({
              type: "thread.create",
              commandId: CommandId.make("bot-run:queued-1:create"),
              threadId: ThreadId.make("bot-run:queued-1"),
              projectId,
              title: "Builder: Recover this task",
              modelSelection: bot.modelSelection,
              runtimeMode: "full-access",
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
