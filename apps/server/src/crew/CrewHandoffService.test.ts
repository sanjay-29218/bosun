// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CrewTestOrchestration, seedCrewProject } from "./CrewRuntime.testkit.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { CrewService } from "./CrewService.ts";
import { CrewHandoffService, WORKFLOW_HANDOFF_PREFIX } from "./CrewHandoffService.ts";
import { CrewHandoffStore } from "./CrewHandoffStore.ts";
import { CrewRuntimeLive } from "./runtimeLayer.ts";

const projectId = ProjectId.make("bot-handoff-test-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-sol" };

const withSystem = <A, E>(
  path: string,
  use: (services: {
    readonly bots: CrewService["Service"];
    readonly handoffs: CrewHandoffService["Service"];
    readonly store: CrewHandoffStore["Service"];
    readonly engine: OrchestrationEngineService["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly settings: ServerSettingsService["Service"];
  }) => Effect.Effect<A, E, SqlClient.SqlClient | ProjectStore.ProjectStoreV2>,
) => {
  const orchestration = CrewTestOrchestration;
  const layer = Layer.mergeAll(
    orchestration,
    CrewRuntimeLive.pipe(Layer.provide(orchestration)),
  ).pipe(
    Layer.provideMerge(SqlitePersistence.layerFromPath(path)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "bot-handoff-test-" })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return Effect.gen(function* () {
    return yield* use({
      bots: yield* CrewService,
      handoffs: yield* CrewHandoffService,
      store: yield* CrewHandoffStore,
      engine: yield* OrchestrationEngineService,
      sql: yield* SqlClient.SqlClient,
      settings: yield* ServerSettingsService,
    });
  }).pipe(Effect.provide(layer));
};

describe("Bot handoffs", () => {
  effectIt.effect("routes questions and answers while rejecting unauthorized delegation", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-handoff-question-")),
      );
      yield* withSystem(
        NodePath.join(directory, "state.sqlite"),
        ({ bots, handoffs, store, sql }) =>
          Effect.gen(function* () {
            yield* seedCrewProject({
              projectId,
              title: "Handoff questions",
              workspaceRoot: directory,
            });
            yield* bots.ensureDefaults(modelSelection);
            yield* bots.ensureProjectManager(projectId);
            const captain = yield* bots.createRun({
              id: "captain-question",
              memberId: "bot-captain",
              projectId,
              taskText: "Coordinate a question",
            });
            const managerRequest = yield* handoffs.delegate({
              id: "manager-question",
              sourceThreadId: captain.threadId,
              targetMemberId: `bot-manager:${projectId}`,
              projectId,
              taskText: "Clarify and execute",
            });
            const manager = (yield* bots.getRun(managerRequest.targetRunId))!.run;
            const executionRequest = yield* handoffs.delegate({
              id: "builder-question",
              sourceThreadId: manager.threadId,
              targetMemberId: `bot-builder:${projectId}`,
              projectId,
              taskText: "Implement after clarification",
            });
            const execution = (yield* bots.getRun(executionRequest.targetRunId))!.run;
            expect(
              (yield* handoffs
                .delegate({
                  id: "forbidden",
                  sourceThreadId: execution.threadId,
                  targetMemberId: `bot-manager:${projectId}`,
                  projectId,
                  taskText: "Escalate improperly",
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(
              (yield* handoffs
                .delegate({
                  id: "builder-question",
                  sourceThreadId: manager.threadId,
                  targetMemberId: `bot-builder:${projectId}`,
                  projectId,
                  taskText: "Different task",
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            expect(
              (yield* handoffs
                .delegate({
                  id: "oversized",
                  sourceThreadId: manager.threadId,
                  targetMemberId: `bot-builder:${projectId}`,
                  projectId,
                  taskText: "x".repeat(8_001),
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            const question = yield* handoffs.ask(execution.threadId, "Which file?");
            expect(question.status).toBe("needs-input");
            expect((yield* store.listByProject(projectId, 1)).length).toBe(2);
            expect((yield* handoffs.waitFor(manager.threadId, question.id)).questionText).toBe(
              "Which file?",
            );
            const answered = yield* handoffs.answerFromBot(
              manager.threadId,
              question.id,
              "Use src/main.ts",
            );
            expect(answered.status).toBe("running");
            expect(answered.notificationState).toBe("delivered");
            expect(
              (yield* handoffs.answerFromBot(manager.threadId, question.id, "Use src/main.ts")).id,
            ).toBe(question.id);
            expect(
              (yield* handoffs.respond(execution.threadId, "completed", "Updated src/main.ts"))
                .status,
            ).toBe("completed");
            expect((yield* handoffs.waitFor(manager.threadId, question.id)).responseText).toBe(
              "Updated src/main.ts",
            );
            const late = yield* handoffs.delegate({
              id: "builder-late",
              sourceThreadId: manager.threadId,
              targetMemberId: `bot-builder:${projectId}`,
              projectId,
              taskText: "Finish after the manager is gone",
            });
            const cancelled = yield* handoffs.cancel(managerRequest.id);
            expect(cancelled.status).toBe("cancelled");
            // A manager whose own handoff ended is superseded: late results don't wake it, and it
            // can't start more work beside whoever replaces it.
            const lateRun = (yield* bots.getRun(late.targetRunId))!.run;
            yield* handoffs.respond(lateRun.threadId, "completed", "Done late");
            const lateNotices = yield* sql`
            SELECT 1 FROM orchestration_v2_projection_messages
            WHERE message_id = 'bot-handoff:builder-late:notice:1'
          `;
            expect(lateNotices).toHaveLength(0);
            expect(
              (yield* handoffs
                .delegate({
                  id: "builder-after-cancel",
                  sourceThreadId: manager.threadId,
                  targetMemberId: `bot-builder:${projectId}`,
                  projectId,
                  taskText: "Start again",
                })
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            // A workflow still starts its next stage (e.g. after a gate approval) from the
            // manager that started it, whose own handoff has long ended.
            const stage = yield* handoffs.delegate({
              id: "workflow-stage-after-end",
              sourceThreadId: manager.threadId,
              targetMemberId: `bot-builder:${projectId}`,
              projectId,
              taskText: "Next workflow stage",
              boundByWorkflow: true,
            });
            expect(stage.status).not.toBe("failed");
            // Captain may delegate because it owns the project, so retry rechecks the target instead.
            const managerId = `bot-manager:${projectId}`;
            yield* sql`UPDATE crew_members SET enabled = 0 WHERE id = ${managerId}`;
            expect((yield* handoffs.retry(managerRequest.id).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            yield* sql`UPDATE crew_members SET enabled = 1 WHERE id = ${managerId}`;
            const retry = yield* handoffs.retry(managerRequest.id);
            expect(retry.status).toBe("running");
            expect(retry.targetRunId).not.toBe(managerRequest.targetRunId);
            expect(retry.attempt).toBe(2);
            expect(
              (yield* handoffs
                .respond(manager.threadId, "completed", "Late result")
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
          }),
      );
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  effectIt.effect("persists Captain to Manager to Builder and structured outcomes", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-handoff-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      yield* withSystem(databasePath, ({ bots, handoffs, sql }) =>
        Effect.gen(function* () {
          yield* seedCrewProject({
            projectId,
            title: "Handoff test",
            workspaceRoot: directory,
          });
          yield* bots.createMember({
            id: "captain",
            projectId: null,
            name: "Captain",
            instructions: "Coordinate.",
            allowedTools: ["crew.delegate"],
            modelSelection,
            runtimeMode: "approval-required",
          });
          yield* bots.createMember({
            id: "manager",
            projectId,
            name: "Manager",
            instructions: "Manage.",
            allowedTools: ["crew.delegate", "crew.respond", "crew.ask"],
            modelSelection,
            runtimeMode: "approval-required",
          });
          yield* bots.createMember({
            id: "execution",
            projectId,
            name: "Builder",
            instructions: "Execute.",
            allowedTools: ["crew.respond", "crew.ask"],
            modelSelection,
            runtimeMode: "approval-required",
          });
          yield* bots.allowDelegation("captain", "manager");
          yield* bots.allowDelegation("manager", "execution");
          const captain = yield* bots.createRun({
            id: "captain-run",
            memberId: "captain",
            projectId,
            taskText: "Coordinate the change",
          });
          const manager = yield* handoffs.delegate({
            id: "captain-to-manager",
            sourceThreadId: captain.threadId,
            targetMemberId: "manager",
            projectId,
            taskText: "Own the change",
          });
          expect(manager.status).toBe("running");
          expect(
            (yield* handoffs.delegate({
              id: "captain-to-manager",
              sourceThreadId: captain.threadId,
              targetMemberId: "manager",
              projectId,
              taskText: "Own the change",
            })).targetRunId,
          ).toBe(manager.targetRunId);
          const managerRun = (yield* bots.getRun(manager.targetRunId))!.run;
          const execution = yield* handoffs.delegate({
            id: "manager-to-execution",
            sourceThreadId: managerRun.threadId,
            targetMemberId: "execution",
            projectId,
            taskText: "Implement the change",
            contextText: "Keep the patch small.",
          });
          expect(execution.depth).toBe(2);
          const executionRun = (yield* bots.getRun(execution.targetRunId))!.run;
          // A manager ending its turn while its builder works is waiting, not done.
          yield* sql`
            UPDATE orchestration_v2_projection_runs SET status = 'completed'
            WHERE thread_id = ${managerRun.threadId}
          `;
          yield* handoffs.refreshRun(manager.targetRunId);
          expect((yield* handoffs.get(manager.id))?.status).toBe("running");
          const reported = yield* handoffs.respond(
            executionRun.threadId,
            "completed",
            "Patch complete",
          );
          expect(reported.responseText).toBe("Patch complete");
          expect(
            (yield* handoffs.respond(executionRun.threadId, "completed", "Patch complete")).id,
          ).toBe(execution.id);
          expect(
            (yield* handoffs.respond(managerRun.threadId, "completed", "Reviewed patch")).status,
          ).toBe("completed");
          yield* bots.revokeDelegation("manager", "execution");
          expect(
            (yield* handoffs
              .delegate({
                id: "revoked-delegation",
                sourceThreadId: managerRun.threadId,
                targetMemberId: "execution",
                projectId,
                taskText: "Another change",
              })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      );
      yield* withSystem(databasePath, ({ bots, handoffs, sql }) =>
        Effect.gen(function* () {
          expect((yield* handoffs.get("manager-to-execution"))?.responseText).toBe(
            "Patch complete",
          );
          expect((yield* handoffs.get("captain-to-manager"))?.status).toBe("completed");
          const noticesBefore = yield* sql<{ readonly text: string }>`
            SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
            WHERE message_id = 'bot-handoff:captain-to-manager:notice:1'
          `;
          expect(noticesBefore[0]?.text).toContain("Reviewed patch");
          yield* bots.reconcileRuns();
          const noticesAfter = yield* sql<{ readonly text: string }>`
            SELECT json_extract(payload_json, '$.text') AS text FROM orchestration_v2_projection_messages
            WHERE message_id = 'bot-handoff:captain-to-manager:notice:1'
          `;
          expect(noticesAfter).toEqual(noticesBefore);
        }),
      );
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );
  effectIt.effect("keeps delegated crew work under the crew limit, first in, first out", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-handoff-limit-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, handoffs, settings }) =>
        Effect.gen(function* () {
          yield* settings.updateSettings({ crew: { maxRunningStageThreads: 1 } });
          yield* seedCrewProject({ projectId, title: "Crew limit", workspaceRoot: directory });
          yield* bots.ensureDefaults(modelSelection);
          yield* bots.ensureProjectManager(projectId);
          const captain = yield* bots.createRun({
            id: "captain-limit",
            memberId: "bot-captain",
            projectId,
            taskText: "Coordinate two builds",
          });
          const managerRequest = yield* handoffs.delegate({
            id: "limit-manager",
            sourceThreadId: captain.threadId,
            targetMemberId: `bot-manager:${projectId}`,
            projectId,
            taskText: "Split the work",
          });
          const manager = (yield* bots.getRun(managerRequest.targetRunId))!.run;
          const toBuilder = (id: string) =>
            handoffs.delegate({
              id,
              sourceThreadId: manager.threadId,
              targetMemberId: `bot-builder:${projectId}`,
              projectId,
              taskText: `Build ${id}`,
            });
          // The manager waits on its builders, so the first one takes the only place.
          const first = yield* toBuilder("limit-first");
          expect(first.status).toBe("running");
          expect((yield* toBuilder("limit-second")).status).toBe("queued");
          const firstRun = (yield* bots.getRun(first.targetRunId))!.run;
          yield* handoffs.respond(firstRun.threadId, "completed", "First done");
          expect((yield* handoffs.get("limit-second"))?.status).toBe("running");
        }),
      );
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  effectIt.effect("hands off with the delegator's access and model, except workflow stages", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-handoff-carried-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, handoffs, engine }) =>
        Effect.gen(function* () {
          yield* seedCrewProject({
            projectId,
            title: "Carried settings",
            workspaceRoot: directory,
          });
          yield* bots.ensureDefaults(modelSelection);
          yield* bots.ensureProjectManager(projectId);
          const captain = yield* bots.createRun({
            id: "captain-carried",
            memberId: "bot-captain",
            projectId,
            taskText: "Coordinate with full access",
          });
          const captainModel = {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-sol-max",
          };
          yield* engine.dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("captain-carried:full-access"),
            threadId: captain.threadId,
            runtimeMode: "full-access",
          });
          yield* engine.dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make("captain-carried:model"),
            threadId: captain.threadId,
            modelSelection: captainModel,
          });
          const delegateToManager = (id: string) =>
            handoffs.delegate({
              id,
              sourceThreadId: captain.threadId,
              targetMemberId: `bot-manager:${projectId}`,
              projectId,
              taskText: `Run ${id}`,
            });

          const manager = (yield* bots.getRun((yield* delegateToManager("carried")).targetRunId))!
            .run;
          expect(manager.runtimeMode).toBe("full-access");
          expect(manager.modelSelection).toEqual(captainModel);

          // The manager works in a feature's worktree, so its builder works there too.
          yield* engine.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("carried:worktree"),
            threadId: manager.threadId,
            branch: "bosun/carried",
            worktreePath: "/worktrees/bosun/carried",
          });
          const builderRequest = yield* handoffs.delegate({
            id: "carried-builder",
            sourceThreadId: manager.threadId,
            targetMemberId: `bot-builder:${projectId}`,
            projectId,
            taskText: "Build it on the named model",
            modelSelection,
          });
          const builder = (yield* bots.getRun(builderRequest.targetRunId))!.run;
          expect(builder.runtimeMode).toBe("full-access");
          expect(builder.modelSelection).toEqual(modelSelection);
          expect(yield* engine.getThreadShell(builder.threadId)).toMatchObject({
            branch: "bosun/carried",
            worktreePath: "/worktrees/bosun/carried",
          });

          const stage = (yield* bots.getRun(
            (yield* delegateToManager(`${WORKFLOW_HANDOFF_PREFIX}carried-stage`)).targetRunId,
          ))!.run;
          expect(stage.runtimeMode).toBe("approval-required");
          expect(stage.modelSelection).toEqual(modelSelection);
        }),
      );
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  effectIt.effect("tags a handoff chain's threads with the request or feature they work on", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bot-handoff-tag-")),
      );
      yield* withSystem(NodePath.join(directory, "state.sqlite"), ({ bots, handoffs, engine }) =>
        Effect.gen(function* () {
          yield* seedCrewProject({ projectId, title: "Handoff tags", workspaceRoot: directory });
          yield* bots.ensureDefaults(modelSelection);
          yield* bots.ensureProjectManager(projectId);
          const captain = yield* bots.createRun({
            id: "captain-tags",
            memberId: "bot-captain",
            projectId,
            taskText: "Coordinate triage",
          });
          const delegateTo = (
            id: string,
            sourceThreadId: typeof captain.threadId,
            member: string,
          ) =>
            handoffs
              .delegate({
                id,
                sourceThreadId,
                targetMemberId: `${member}:${projectId}`,
                projectId,
                taskText: `${id}.\n\nDetails follow.`,
              })
              .pipe(Effect.flatMap((handoff) => bots.getRun(handoff.targetRunId)));
          const shellOf = (threadId: typeof captain.threadId) => engine.getThreadShell(threadId);

          const manager = (yield* delegateTo(
            "Triage open issues",
            captain.threadId,
            "bot-manager",
          ))!.run;
          const builder = (yield* delegateTo("Check each issue", manager.threadId, "bot-builder"))!
            .run;
          const request = { id: "Triage open issues", title: "Triage open issues" };
          expect((yield* shellOf(manager.threadId))?.crewRequest).toMatchObject(request);
          expect((yield* shellOf(builder.threadId))?.crewRequest).toEqual({
            ...request,
            member: (yield* bots.getMember(`bot-builder:${projectId}`))!.name,
          });
          expect((yield* shellOf(captain.threadId))?.crewRequest).toBeUndefined();

          yield* handoffs.cancel("Triage open issues");
          const retried = (yield* bots.getRun(
            (yield* handoffs.retry("Triage open issues")).targetRunId,
          ))!.run;
          expect(retried.threadId).not.toBe(manager.threadId);
          expect((yield* shellOf(retried.threadId))?.crewRequest).toMatchObject(request);

          const feature = { id: "feature-1", title: "Clip crop editing" };
          yield* engine.dispatch({
            type: "thread.crew-stage.set",
            commandId: CommandId.make("test:feature-lead"),
            threadId: retried.threadId,
            feature,
          });
          const helper = (yield* delegateTo("Build the handles", retried.threadId, "bot-builder"))!
            .run;
          const helperShell = yield* shellOf(helper.threadId);
          expect(helperShell?.feature).toEqual(feature);
          expect(helperShell?.crewRequest).toEqual({
            ...request,
            member: (yield* bots.getMember(`bot-builder:${projectId}`))!.name,
          });
        }),
      );
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );
});
