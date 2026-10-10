// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { BotService } from "../bots/BotService.ts";
import { BotStore } from "../bots/BotStore.ts";
import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { WorkflowWorkspaceEmpty } from "../workflows/WorkflowWorkspace.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";
import { WorkflowStore } from "../workflows/WorkflowStore.ts";
import { WorkflowExecutionStore } from "../workflows/WorkflowExecutionStore.ts";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  BotTestOrchestration as OrchestrationLayerLive,
  seedBotProject,
} from "../bots/BotRuntime.testkit.ts";
import { OrchestratorV2 as OrchestrationEngineService } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { WorkflowExecutionService } from "../workflows/WorkflowExecutionService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { FeatureService, FeatureServiceLive } from "./FeatureService.ts";

const projectId = ProjectId.make("workflow-feature-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
const encodeBotIdentity = Schema.encodeSync(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
);

const withSystem = <E>(
  exercise: Effect.Effect<
    void,
    E,
    | FeatureService
    | BotService
    | BotStore
    | WorkflowService
    | WorkflowStore
    | WorkflowExecutionStore
    | WorkflowExecutionService
    | OrchestrationEngineService
    | ProjectionStore.ProjectionStoreV2
  >,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "feature-integration-")),
    );
    const orchestration = OrchestrationLayerLive;
    const layer = FeatureServiceLive.pipe(
      Layer.provideMerge(
        WorkflowRuntimeLive.pipe(
          Layer.provide(WorkflowWorkspaceEmpty),
          Layer.provide(orchestration),
        ),
      ),
      Layer.provideMerge(orchestration),
      // Stateless over SQLite, so seeded threads read back through the orchestrator.
      Layer.provideMerge(ProjectionStore.layer),
      Layer.provide(SqlitePersistence.layerFromPath(NodePath.join(directory, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "feature-test-" })),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      yield* seedBotProject({
        projectId,
        title: "Feature project",
        workspaceRoot: directory,
      });
      yield* (yield* BotService).ensureCrew(projectId, modelSelection);
      yield* exercise;
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  });

describe("feature creation", () => {
  effectIt.effect(
    "pins the selected workflow and named crew across edits and duplicate creation",
    () =>
      withSystem(
        Effect.gen(function* () {
          const features = yield* FeatureService;
          const workflows = yield* WorkflowService;
          const bots = yield* BotService;
          const store = yield* BotStore;
          const definition = yield* workflows.ensureStarterDefinition(projectId);
          const selected = {
            ...definition,
            id: "custom-crew",
            name: "Custom crew",
            bots: {
              ...definition.bots,
              second_planner: {
                template: {
                  kind: "template" as const,
                  id: `template:planner:${projectId}`,
                  revision: 1,
                },
                supervisor: "designer",
              },
            },
          };
          yield* workflows.createDefinition(projectId, selected);
          const input = {
            id: "selected-feature",
            projectId,
            title: "Selected workflow",
            brief: "Use the custom crew",
            workflowId: selected.id,
          };
          const created = yield* features.create(input);
          expect(created.workflowId).toBe(selected.id);
          expect(created.workflowRevision).toBe(selected.revision);
          expect((yield* features.get(created.id))?.workflowRevision).toBe(selected.revision);
          expect(created.botAssignments.manager).toBe(`bot-manager:${projectId}`);
          expect(created.botAssignments.second_planner).not.toBe(created.botAssignments.planner);
          const crew = (yield* store.listDefinitionsForProject(projectId)).filter(
            (bot) => bot.featureId === created.id,
          );
          expect(crew).toHaveLength(6);
          expect(crew.every((bot) => bot.templateRevision === 1)).toBe(true);
          expect(
            yield* store.canDelegate(
              created.botAssignments.designer!,
              created.botAssignments.second_planner!,
            ),
          ).toBe(true);
          expect(
            yield* store.canDelegate(
              created.botAssignments.manager!,
              created.botAssignments.second_planner!,
            ),
          ).toBe(false);
          const copy = yield* workflows.getFeatureCopy(created.id);
          const template = (yield* store.getTemplate(`template:planner:${projectId}`))!;
          yield* bots.updateTemplate({
            ...template,
            expectedRevision: template.revision,
            instructions: "Updated planner",
          });
          const revised = {
            ...selected,
            revision: 2,
            bots: {
              ...selected.bots,
              planner: {
                ...definition.bots.planner!,
                template: { kind: "template" as const, id: template.id, revision: 2 },
              },
              second_planner: {
                ...selected.bots.second_planner,
                template: { ...selected.bots.second_planner.template, revision: 2 },
              },
            },
          };
          yield* workflows.reviseDefinition(projectId, revised, 1);
          expect(yield* features.create(input)).toEqual(created);
          expect(yield* features.get(created.id)).toEqual(created);
          expect(yield* workflows.getFeatureCopy(created.id)).toEqual(copy);
          expect((yield* store.getDefinition(created.botAssignments.planner!))?.instructions).toBe(
            template.instructions,
          );
          expect(
            (yield* features.create({ ...input, workflowId: definition.id }).pipe(Effect.result))
              ._tag,
          ).toBe("Failure");
          expect(
            (yield* features.setStatus(created.id, projectId, "closed")).botAssignments,
          ).toEqual(created.botAssignments);
          expect((yield* features.setStatus(created.id, projectId, "open")).botAssignments).toEqual(
            created.botAssignments,
          );
          expect(yield* workflows.getFeatureCopy(created.id)).toEqual(copy);
        }),
      ),
  );

  effectIt.effect(
    "rolls back a failed attachment and retries without leftover bots or copies",
    () =>
      withSystem(
        Effect.gen(function* () {
          const features = yield* FeatureService;
          const workflows = yield* WorkflowService;
          const store = yield* BotStore;
          const bots = yield* BotService;
          const input = {
            id: "recovered-feature",
            projectId,
            title: "Recover creation",
            brief: "Retry safely",
            workflowId: "feature-delivery",
          };
          expect((yield* features.create(input).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* features.get(input.id)).toBeNull();
          expect(yield* workflows.getFeatureCopy(input.id)).toBeNull();
          yield* workflows.ensureStarterDefinition(projectId);
          // Fail after snapshot creation and the first bot insert to exercise transaction rollback.
          const lateInput = { ...input, id: "late-failure" };
          const collisionId = `feature-bot:${NodeCrypto.createHash("sha256")
            .update(encodeBotIdentity([lateInput.id, "designer"]))
            .digest("hex")
            .slice(0, 32)}`;
          yield* bots.createDefinition({
            id: collisionId,
            projectId,
            name: "Existing unrelated bot",
            instructions: "Keep me",
            allowedTools: [],
            modelSelection,
            runtimeMode: "approval-required",
          });
          expect((yield* features.create(lateInput).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* features.get(lateInput.id)).toBeNull();
          expect(yield* workflows.getFeatureCopy(lateInput.id)).toBeNull();
          expect(
            (yield* store.listDefinitionsForProject(projectId)).filter(
              (bot) => bot.featureId === lateInput.id,
            ),
          ).toHaveLength(0);
          const created = yield* features.create(input);
          expect(created.status).toBe("open");
          expect(yield* features.create(input)).toEqual(created);
        }),
      ),
  );

  effectIt.effect("requires a terminal workflow before closing an attached execution", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const workflows = yield* WorkflowService;
        const executions = yield* WorkflowExecutionStore;
        yield* workflows.ensureStarterDefinition(projectId);
        const feature = yield* features.create({
          id: "executing-feature",
          projectId,
          title: "Running",
          brief: "Keep work visible",
          workflowId: "feature-delivery",
        });
        yield* executions.attach(feature.id, {});
        expect(
          (yield* features.setStatus(feature.id, projectId, "closed").pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect((yield* features.get(feature.id))?.status).toBe("open");
        yield* workflows.recordTrustedEvent(feature.id, {
          id: "cancel",
          stepId: "plan",
          executionId: null,
          kind: "cancelled",
          botRunId: null,
          outcome: null,
          sourceKind: null,
          sourceId: null,
          actorId: "user",
          detail: null,
          occurredAt: "2026-09-30T00:00:00.000Z",
        });
        expect((yield* features.setStatus(feature.id, projectId, "closed")).status).toBe("closed");
        expect((yield* features.setStatus(feature.id, projectId, "open")).status).toBe("open");
        expect((yield* workflows.getFeatureSnapshot(feature.id, projectId))?.cancelled).toBe(true);
      }),
    ),
  );
  effectIt.effect("creates a feature with independent enabled bot instances exactly once", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workflow-feature-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const orchestration = OrchestrationLayerLive;
      const botRuntime = WorkflowRuntimeLive.pipe(
        Layer.provide(WorkflowWorkspaceEmpty),
        Layer.provide(orchestration),
      );
      const layer = FeatureServiceLive.pipe(
        Layer.provideMerge(botRuntime),
        Layer.provideMerge(orchestration),
        Layer.provide(SqlitePersistence.layerFromPath(databasePath)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "feature-test-" })),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(NodeServices.layer),
      );
      const exercise = Effect.gen(function* () {
        const bots = yield* BotService;
        const botStore = yield* BotStore;
        const features = yield* FeatureService;
        yield* seedBotProject({
          projectId,
          title: "Workflow feature project",
          workspaceRoot: `/tmp/${projectId}`,
        });
        yield* bots.ensureCrew(projectId, modelSelection);
        const extra = yield* bots.createTemplate({
          id: "template:writer",
          projectId,
          name: "Writer",
          instructions: "Write the feature copy.",
          allowedTools: [],
          modelSelection,
          runtimeMode: "approval-required",
          autoCreateForFeature: true,
        });
        const disabled = yield* bots.createTemplate({
          id: "template:disabled",
          projectId,
          name: "Disabled",
          instructions: "Do not copy me.",
          allowedTools: [],
          modelSelection,
          runtimeMode: "approval-required",
          autoCreateForFeature: true,
        });
        yield* bots.updateTemplate({
          ...disabled,
          expectedRevision: disabled.revision,
          enabled: false,
        });

        const input = {
          id: "feature-one",
          projectId,
          title: "Deliver the feature",
          brief: "Plan, build, test, and review it.",
        };
        const created = yield* features.create(input);
        expect(created.status).toBe("open");
        expect(created.updatedAt).toBe(created.createdAt);
        expect(created.workflowId).toBeNull();
        expect(created.workflowRevision).toBeNull();
        const featureBots = (yield* botStore.listDefinitionsForProject(projectId)).filter(
          (bot) => bot.featureId === input.id,
        );
        expect(featureBots).toHaveLength(6);
        expect(featureBots.map((bot) => bot.templateId)).toContain(extra.id);
        expect(featureBots.map((bot) => bot.templateId)).not.toContain(disabled.id);
        expect(featureBots.every((bot) => bot.templateRevision === 1)).toBe(true);
        for (const bot of featureBots) {
          expect(yield* botStore.canDelegate(`bot-manager:${projectId}`, bot.id)).toBe(true);
        }

        yield* bots.updateTemplate({
          ...extra,
          expectedRevision: extra.revision,
          instructions: "New template instructions",
        });
        expect(yield* features.create(input)).toEqual(created);
        expect((yield* features.listByProject(projectId)).map((feature) => feature.id)).toEqual([
          input.id,
        ]);
        expect(
          (yield* botStore.getDefinition(
            featureBots.find((bot) => bot.templateId === extra.id)!.id,
          ))?.instructions,
        ).toBe("Write the feature copy.");
        expect(
          (yield* features.create({ ...input, title: "Different" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(
          (yield* features
            .create({ ...input, id: "bad-feature", projectId: ProjectId.make("missing-project") })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(yield* features.get("bad-feature")).toBeNull();
        const closed = yield* features.setStatus(created.id, projectId, "closed");
        expect(closed.status).toBe("closed");
        expect(yield* features.setStatus(created.id, projectId, "closed")).toEqual(closed);
        expect(
          (yield* features
            .setStatus(created.id, ProjectId.make("another-project"), "open")
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        const reopened = yield* features.setStatus(created.id, projectId, "open");
        expect(reopened.status).toBe("open");
        expect(reopened.botAssignments).toEqual(created.botAssignments);
        expect(
          (yield* botStore.listDefinitionsForProject(projectId)).filter(
            (bot) => bot.featureId === created.id,
          ),
        ).toHaveLength(6);
      }).pipe(Effect.provide(layer));
      yield* exercise.pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});

/** A person's thread whose latest turn has `status`, ending with `reply` when it has one. */
const seedThread = (
  id: string,
  options: {
    readonly status: OrchestrationV2Run["status"];
    readonly reply?: string;
    readonly project?: ProjectId;
    readonly archived?: boolean;
  },
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(id);
    const runId = RunId.make(`${id}:run`);
    const instanceId = ProviderInstanceId.make("codex");
    yield* store.apply({
      id: EventId.make(`${id}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: options.project ?? projectId,
        title: "Reconnect loop after sleep",
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "fix/reconnect",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: options.archived ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const message = (role: "user" | "assistant", text: string) =>
      store.apply({
        id: EventId.make(`${id}:${role}`),
        type: "message.updated",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: MessageId.make(`${id}:${role}`),
          threadId,
          runId,
          nodeId: null,
          role,
          text,
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      });
    yield* message("user", "The socket reconnects twice after the laptop sleeps.");
    yield* setRun(id, options.status);
    if (options.reply) yield* message("assistant", options.reply);
    return threadId;
  });

const setRun = (id: string, status: OrchestrationV2Run["status"]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(id);
    const instanceId = ProviderInstanceId.make("codex");
    yield* store.apply({
      id: EventId.make(`${id}:run:${status}`),
      type: "run.updated",
      threadId,
      runId: RunId.make(`${id}:run`),
      occurredAt: now,
      payload: {
        id: RunId.make(`${id}:run`),
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        providerThreadId: null,
        userMessageId: MessageId.make(`${id}:user`),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  });

describe("making a thread a feature", () => {
  // Stage bots report through bots_respond; the crew's starter templates grant no tools.
  const grantStageTools = Effect.gen(function* () {
    const bots = yield* BotService;
    const store = yield* BotStore;
    for (const role of ["planner", "designer", "builder", "qa-tester", "reviewer"]) {
      const template = (yield* store.getTemplate(`template:${role}:${projectId}`))!;
      if (template.allowedTools.includes("bots.respond")) continue;
      yield* bots.updateTemplate({
        ...template,
        expectedRevision: template.revision,
        allowedTools: ["bots.respond", "bots.ask"],
      });
    }
  });
  const attach = (threadId: ThreadId, stageId: string, featureId = "attached") =>
    Effect.gen(function* () {
      yield* grantStageTools;
      const workflow = yield* (yield* WorkflowService).ensureStarterDefinition(projectId);
      return yield* (yield* FeatureService).attachThread({
        featureId,
        projectId,
        threadId,
        workflowId: workflow.id,
        stageId,
        title: "Reconnect loop after sleep",
        actorId: "person",
      });
    });
  const status = (
    snapshot: { readonly steps: ReadonlyArray<{ readonly id: string; readonly status: string }> },
    stepId: string,
  ) => snapshot.steps.find((step) => step.id === stepId)?.status;

  effectIt.effect("skips earlier stages and finishes the stage when the thread's turn ends", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const threadId = yield* seedThread("thread:attach", { status: "running" });
        const snapshot = yield* attach(threadId, "review");
        for (const stepId of ["plan", "design", "build", "qa"]) {
          expect(status(snapshot, stepId)).toBe("skipped");
        }
        expect(snapshot.activeStepId).toBe("review");
        expect(snapshot.steps.find((step) => step.id === "review")).toMatchObject({
          status: "taken-over",
          threadId,
          botRunId: null,
        });
        expect((yield* features.get("attached"))?.brief).toBe(
          "The socket reconnects twice after the laptop sleeps.",
        );
        expect(yield* features.threadLink(projectId, threadId)).toEqual({
          stage: {
            featureId: "attached",
            stepId: "review",
            index: 5,
            total: 6,
            state: "working",
            current: true,
          },
          attachable: true,
        });
        // A retry returns the same feature; the same ID for another stage, or a second
        // feature for the same thread, is refused.
        expect((yield* attach(threadId, "review")).activeStepId).toBe("review");
        expect((yield* attach(threadId, "qa").pipe(Effect.flip)).message).toContain(
          "another request",
        );
        expect(
          (yield* (yield* FeatureService)
            .attachThread({
              featureId: "attached",
              projectId,
              threadId,
              workflowId: "feature-delivery",
              stageId: "review",
              title: "Another title",
              actorId: "person",
            })
            .pipe(Effect.flip)).message,
        ).toContain("another request");
        expect((yield* attach(threadId, "review", "second").pipe(Effect.flip)).message).toContain(
          "already a feature's current stage",
        );

        // A failed turn leaves the stage open; a finished one completes it with the reply.
        const execution = yield* WorkflowExecutionService;
        yield* setRun("thread:attach", "failed");
        yield* execution.reconcileFeature("attached");
        expect((yield* (yield* WorkflowService).getFeatureState("attached"))?.activeStepId).toBe(
          "review",
        );
        yield* setRun("thread:attach", "completed");
        yield* execution.reconcileFeature("attached");
        const done = (yield* (yield* WorkflowService).getFeatureSnapshot("attached", projectId))!;
        expect(done.completed).toBe(true);
        expect(done.recentEvents.at(-1)).toMatchObject({
          kind: "completed",
          stepId: "review",
          outcome: "approved",
          sourceKind: "workflow",
          detail: 'Finished in thread "Reconnect loop after sleep"',
        });
        expect((yield* features.threadLink(projectId, threadId)).stage?.current).toBe(false);
      }),
    ),
  );

  effectIt.effect("hands a finished thread's result to the stage's gate straight away", () =>
    withSystem(
      Effect.gen(function* () {
        const threadId = yield* seedThread("thread:finished", {
          status: "completed",
          reply: "The plan: clear the backoff timer on sleep.",
        });
        const snapshot = yield* attach(threadId, "plan");
        expect(snapshot.state).toBe("approval");
        expect(snapshot.steps.find((step) => step.id === "plan")).toMatchObject({
          status: "awaiting-approval",
          pendingOutcome: "ready",
          threadId,
        });
        expect(snapshot.recentEvents.at(-1)?.detail).toBe(
          "The plan: clear the backoff timer on sleep.",
        );

        // Detached at the gate and reopened, the stage waits for a new turn: the finished one
        // has already been handed on, and reconciling must not record it again.
        const features = yield* FeatureService;
        yield* features.detachThread({
          projectId,
          threadId,
          requestId: "detach-at-gate",
          actorId: "person",
        });
        const reopened = yield* features.reopen({
          id: "attached",
          projectId,
          requestId: "reopen-at-gate",
          actorId: "person",
        });
        expect(reopened.steps.find((step) => step.id === "plan")).toMatchObject({
          status: "taken-over",
          threadId,
        });
        yield* (yield* WorkflowExecutionService).reconcileFeature("attached");
        expect(
          (yield* (yield* WorkflowService).getFeatureState("attached"))?.steps.get("plan")?.status,
        ).toBe("taken-over");
      }),
    ),
  );

  effectIt.effect("detaches to a plain thread, and reopening reattaches it", () =>
    withSystem(
      Effect.gen(function* () {
        const features = yield* FeatureService;
        const threadId = yield* seedThread("thread:detach", { status: "running" });
        yield* attach(threadId, "review");
        const detach = (requestId: string) =>
          features.detachThread({ projectId, threadId, requestId, actorId: "person" });
        const detached = yield* detach("detach-1");
        expect(detached.cancelled).toBe(true);
        expect(detached.recentEvents.at(-1)?.detail).toBe("Detached from the workflow");
        expect((yield* features.threadLink(projectId, threadId)).stage?.current).toBe(false);
        expect((yield* detach("detach-1")).cancelled).toBe(true);
        expect((yield* detach("detach-2").pipe(Effect.flip)).message).toContain(
          "not a feature's current stage",
        );

        const reopen = (requestId: string) =>
          features.reopen({ id: "attached", projectId, requestId, actorId: "person" });
        const reopened = yield* reopen("reopen-1");
        expect(reopened.steps.find((step) => step.id === "review")).toMatchObject({
          status: "taken-over",
          threadId,
        });
        expect((yield* features.threadLink(projectId, threadId)).stage?.current).toBe(true);

        // Once the thread joins another feature, the first one can no longer take it back,
        // and a retried detach still lands on the feature it first detached.
        yield* detach("detach-3");
        yield* attach(threadId, "review", "second");
        expect((yield* reopen("reopen-2").pipe(Effect.flip)).message).toContain(
          "now another feature's stage",
        );
        expect((yield* detach("detach-3")).featureId).toBe("attached");
        expect((yield* features.threadLink(projectId, threadId)).stage).toMatchObject({
          featureId: "second",
          current: true,
        });
      }),
    ),
  );

  effectIt.effect("refuses threads it cannot make a feature", () =>
    withSystem(
      Effect.gen(function* () {
        const archived = yield* seedThread("thread:archived", {
          status: "running",
          archived: true,
        });
        expect((yield* attach(archived, "review").pipe(Effect.flip)).message).toContain(
          "Unarchive",
        );
        const elsewhere = yield* seedThread("thread:elsewhere", {
          status: "running",
          project: ProjectId.make("another-project"),
        });
        expect((yield* attach(elsewhere, "review").pipe(Effect.flip)).message).toContain(
          "not found in project",
        );
        const plain = yield* seedThread("thread:off-path", { status: "running" });
        expect((yield* attach(plain, "change_review").pipe(Effect.flip)).message).toContain(
          "workflow's path",
        );
        expect(yield* (yield* FeatureService).get("attached")).toBeNull();
      }),
    ),
  );
});
