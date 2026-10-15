// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, WorkflowHandoffOutcome } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { BotService, BotServiceLive } from "../bots/BotService.ts";
import { BotStore, BotStoreLive } from "../bots/BotStore.ts";
import { BotThreadRuntime, type BotThreadStart } from "../bots/BotThreadRuntime.ts";
import { BotHandoffService, BotHandoffServiceLive } from "../bots/BotHandoffService.ts";
import { BotHandoffStore, BotHandoffStoreLive } from "../bots/BotHandoffStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { WorkflowService, WorkflowServiceLive } from "../workflows/WorkflowService.ts";
import { WorkflowStoreLive } from "../workflows/WorkflowStore.ts";
import {
  WorkflowExecutionStore,
  WorkflowExecutionStoreLive,
} from "../workflows/WorkflowExecutionStore.ts";
import {
  WorkflowExecutionService,
  WorkflowExecutionServiceLive,
} from "../workflows/WorkflowExecutionService.ts";
import { FeatureService, FeatureServiceLive } from "./FeatureService.ts";
import { FeatureLaunchService, FeatureLaunchServiceLive } from "./FeatureLaunchService.ts";
import { FeatureLaunchStoreLive } from "./FeatureLaunchStore.ts";

const projectId = ProjectId.make("feature-launch-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const encodeOutcome = Schema.encodeSync(Schema.fromJsonString(WorkflowHandoffOutcome));

const fixture = (directory: string) => {
  const starts: Array<BotThreadStart> = [];
  const interruptions: Array<string> = [];
  let failSupervisor = false;
  let beforeSupervisor: (() => Effect.Effect<void>) | null = null;
  const runtime = Layer.succeed(
    BotThreadRuntime,
    BotThreadRuntime.of({
      projectExists: () => Effect.succeed(true),
      start: (input) =>
        Effect.gen(function* () {
          if (input.runId.startsWith("bot-handoff:feature-supervisor:")) {
            if (beforeSupervisor) yield* beforeSupervisor();
            if (failSupervisor) {
              failSupervisor = false;
              return yield* new OrchestrationCommandInvariantError({
                commandType: "thread.turn.start",
                detail: "Supervisor dispatch unavailable",
              });
            }
          }
          starts.push(input);
        }),
      replayPending: () => Effect.void,
      notify: () => Effect.void,
      interrupt: (threadId) =>
        Effect.sync(() => {
          interruptions.push(threadId);
        }),
      listPendingStartedRunIds: () => Effect.succeed([]),
      getTurnState: () => Effect.succeed("running"),
    }),
  );
  const bots = BotHandoffServiceLive.pipe(
    Layer.provideMerge(BotHandoffStoreLive),
    Layer.provideMerge(
      BotServiceLive.pipe(Layer.provideMerge(BotStoreLive), Layer.provideMerge(runtime)),
    ),
  );
  const workflow = WorkflowExecutionServiceLive.pipe(
    Layer.provideMerge(WorkflowExecutionStoreLive),
    Layer.provideMerge(
      WorkflowServiceLive.pipe(Layer.provideMerge(WorkflowStoreLive), Layer.provideMerge(bots)),
    ),
  );
  const layer = FeatureLaunchServiceLive.pipe(
    Layer.provideMerge(FeatureServiceLive),
    Layer.provideMerge(FeatureLaunchStoreLive),
    Layer.provideMerge(workflow),
    Layer.provideMerge(OrchestrationLayerLive),
    Layer.provideMerge(makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(directory, { prefix: "feature-launch-" })),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(NodeServices.layer),
  );
  return {
    layer,
    starts,
    interruptions,
    failNextSupervisor: () => {
      failSupervisor = true;
    },
    beforeSupervisor: (callback: () => Effect.Effect<void>) => {
      beforeSupervisor = callback;
    },
  };
};

const withDirectory = <A, E, R>(use: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "feature-launch-")),
    );
    return yield* use(directory).pipe(
      Effect.ensuring(
        Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
      ),
    );
  });

const seed = Effect.gen(function* () {
  const bots = yield* BotService;
  const workflows = yield* WorkflowService;
  const features = yield* FeatureService;
  yield* bots.ensureCrew(projectId, modelSelection);
  const managerId = `bot-manager:${projectId}`;
  yield* workflows.createDefinition(projectId, {
    schemaVersion: 1,
    id: "launch-workflow",
    name: "Feature launch",
    revision: 1,
    start: "plan",
    bots: {
      lead: { template: { kind: "existing-project-bot", id: managerId }, supervisor: null },
      writer: {
        template: { kind: "template", id: `template:planner:${projectId}`, revision: 1 },
        supervisor: "lead",
      },
    },
    steps: {
      plan: { type: "task", bot: "writer", task: "Plan the feature", next: { ready: "end" } },
      end: { type: "end" },
    },
    defaults: {
      questions: "supervisor",
      failure: "pause",
      maxAttemptsPerExecution: 3,
      maxStepExecutions: 10,
    },
  });
  const feature = yield* features.create({
    id: "launch-feature",
    projectId,
    title: "Search",
    brief: "Build search for saved documents",
    workflowId: "launch-workflow",
  });
  const source = yield* bots.createRun({
    id: "launch-source",
    botId: "bot-captain",
    projectId,
    taskText: "Coordinate the selected feature",
  });
  return {
    feature,
    source,
    input: { featureId: feature.id, projectId, sourceRunId: source.id, actorId: "session-one" },
  };
});

describe("feature launch", () => {
  it.effect("uses grants for an arbitrary source bot and rejects a competing source run", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { feature, input } = yield* seed;
        const bots = yield* BotService;
        const launches = yield* FeatureLaunchService;
        const coordinator = yield* bots.createDefinition({
          id: "custom-coordinator",
          projectId,
          name: "Research coordinator",
          instructions: "Coordinate the assigned workflow",
          allowedTools: ["bots.delegate"],
          modelSelection,
          runtimeMode: "approval-required",
        });
        const source = yield* bots.createRun({
          id: "custom-source",
          botId: coordinator.id,
          projectId,
          taskText: "Launch search",
        });
        const request = { ...input, sourceRunId: source.id };
        expect((yield* launches.launch(request).pipe(Effect.result))._tag).toBe("Failure");
        expect(system.starts).toHaveLength(2);
        expect(yield* launches.get(feature.id, projectId)).toBeNull();
        yield* bots.allowDelegation(coordinator.id, feature.botAssignments.lead!);
        const record = yield* launches.launch(request);
        expect(record.sourceRunId).toBe(source.id);
        expect((yield* launches.launch(input).pipe(Effect.result))._tag).toBe("Failure");
        expect(system.starts).toHaveLength(4);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect(
    "recovers a process interruption and replays attached work without duplicate handoffs",
    () =>
      withDirectory((directory) =>
        Effect.gen(function* () {
          const first = fixture(directory);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const { feature, input } = yield* seed;
              const reached = yield* Deferred.make<void>();
              first.beforeSupervisor(() =>
                Deferred.succeed(reached, undefined).pipe(Effect.andThen(Effect.never)),
              );
              const fiber = yield* (yield* FeatureLaunchService)
                .launch(input)
                .pipe(Effect.forkScoped);
              yield* Deferred.await(reached);
              yield* Fiber.interrupt(fiber);
              expect((yield* (yield* FeatureLaunchService).get(feature.id, projectId))?.phase).toBe(
                "pending",
              );
            }),
          ).pipe(Effect.provide(first.layer));
          const resumed = fixture(directory);
          yield* Effect.gen(function* () {
            const launches = yield* FeatureLaunchService;
            yield* launches.reconcile();
            expect((yield* launches.get("launch-feature", projectId))?.phase).toBe("attached");
            expect(yield* (yield* BotStore).listRunSummaries(projectId, 100)).toHaveLength(3);
            expect(resumed.starts).toHaveLength(2);
          }).pipe(Effect.provide(resumed.layer));
          const attached = fixture(directory);
          yield* Effect.gen(function* () {
            const launches = yield* FeatureLaunchService;
            yield* launches.reconcile();
            const record = (yield* launches.get("launch-feature", projectId))!;
            expect(yield* launches.launch(record)).toEqual(record);
            expect(attached.starts).toHaveLength(0);
            expect(yield* (yield* BotStore).listRunSummaries(projectId, 100)).toHaveLength(3);
          }).pipe(Effect.provide(attached.layer));
        }),
      ),
  );

  it.effect("applies persisted cancellation before restarting queued setup work", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const first = fixture(directory);
        yield* Effect.gen(function* () {
          const { feature, input } = yield* seed;
          first.failNextSupervisor();
          expect(
            (yield* (yield* FeatureLaunchService).launch(input).pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* (yield* WorkflowExecutionService).control({
            featureId: feature.id,
            projectId,
            requestId: "cancel-before-restart",
            actorId: input.actorId,
            kind: "cancelled",
          });
        }).pipe(Effect.provide(first.layer));
        const restarted = fixture(directory);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const launches = yield* FeatureLaunchService;
            yield* launches.start();
            yield* (yield* BotService).reconcileRuns();
            yield* (yield* BotHandoffService).reconcile();
            yield* launches.reconcile();
            expect((yield* launches.get("launch-feature", projectId))?.phase).toBe("cancelled");
            expect(restarted.starts).toHaveLength(0);
            expect(yield* (yield* WorkflowExecutionStore).get("launch-feature")).toBeNull();
          }),
        ).pipe(Effect.provide(restarted.layer));
      }),
    ),
  );

  it.effect("serializes concurrent requests and keeps questions with the prepared supervisor", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { feature, input } = yield* seed;
        const launches = yield* FeatureLaunchService;
        const workflows = yield* WorkflowService;
        const runner = yield* WorkflowExecutionService;
        const handoffs = yield* BotHandoffStore;
        const delegation = yield* BotHandoffService;
        const bots = yield* BotStore;
        const repeated = yield* Effect.all([launches.launch(input), launches.launch(input)], {
          concurrency: 2,
        });
        expect(repeated[0]).toEqual(repeated[1]);
        expect(system.starts).toHaveLength(3);
        const execution = (yield* (yield* WorkflowExecutionStore).get(feature.id))!;
        const snapshot = (yield* workflows.getFeatureSnapshot(feature.id, projectId))!;
        const run = (yield* bots.getRun(
          snapshot.steps.find((step) => step.id === "plan")!.botRunId!,
        ))!;
        const supervisor = (yield* bots.getRun(execution.bindings.writer!.dispatchRunId))!;
        yield* delegation.ask(run.threadId, "Should search include archived documents?");
        yield* runner.reconcileFeature(feature.id);
        expect((yield* workflows.getFeatureSnapshot(feature.id, projectId))?.steps[0]?.status).toBe(
          "needs-input",
        );
        const question = (yield* handoffs.getForTargetRun(run.id))!;
        expect(question.sourceRunId).toBe(supervisor.id);
        const root = (yield* bots.getRun(input.sourceRunId))!;
        expect(
          (yield* delegation.answerFromBot(root.threadId, question.id, "Yes").pipe(Effect.result))
            ._tag,
        ).toBe("Failure");
        yield* delegation.answerFromBot(
          supervisor.threadId,
          question.id,
          "Include archived documents",
        );
        yield* runner.reconcileFeature(feature.id);
        expect((yield* workflows.getFeatureSnapshot(feature.id, projectId))?.steps[0]?.status).toBe(
          "running",
        );
        expect((yield* workflows.getFeatureSnapshot(feature.id, projectId))?.completed).toBe(false);
        yield* launches.launch(input);
        expect(system.starts).toHaveLength(3);
        yield* delegation.respond(
          run.threadId,
          "completed",
          encodeOutcome({ outcome: "ready", summary: "Plan verified" }),
        );
        yield* runner.reconcileFeature(feature.id);
        expect((yield* workflows.getFeatureSnapshot(feature.id, projectId))?.completed).toBe(true);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("cancels setup while supervisor dispatch is in flight", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { feature, input } = yield* seed;
        const runner = yield* WorkflowExecutionService;
        system.beforeSupervisor(() =>
          runner
            .control({
              featureId: feature.id,
              projectId,
              requestId: "cancel-in-flight",
              actorId: input.actorId,
              kind: "cancelled",
            })
            .pipe(Effect.orDie, Effect.asVoid),
        );
        const result = yield* (yield* FeatureLaunchService).launch(input);
        expect(result.phase).toBe("cancelled");
        expect(system.starts).toHaveLength(2);
        expect(system.interruptions).toHaveLength(1);
        expect(yield* (yield* WorkflowExecutionStore).get(feature.id)).toBeNull();
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("cancels the active task and its prepared supervisor from workflow changes", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.scoped(
        Effect.gen(function* () {
          const { feature, input } = yield* seed;
          const launches = yield* FeatureLaunchService;
          yield* launches.start();
          yield* launches.launch(input);
          const done = yield* Deferred.make<void>();
          const changes = yield* (yield* BotHandoffStore).subscribeChanges;
          yield* changes.pipe(
            Stream.runForEach(() =>
              Effect.gen(function* () {
                if (system.interruptions.length === 2) yield* Deferred.succeed(done, undefined);
              }),
            ),
            Effect.forkScoped,
          );
          yield* (yield* WorkflowExecutionService).control({
            featureId: feature.id,
            projectId,
            requestId: "cancel-active",
            actorId: input.actorId,
            kind: "cancelled",
          });
          yield* Deferred.await(done);
          yield* launches.reconcile();
          expect((yield* launches.get(feature.id, projectId))?.phase).toBe("cancelled");
          const bindings = (yield* (yield* WorkflowExecutionStore).get(feature.id))!.bindings;
          const supervisor = (yield* (yield* BotHandoffStore).getForTargetRun(
            bindings.writer!.dispatchRunId,
          ))!;
          expect(supervisor.status).toBe("cancelled");
          expect(system.interruptions).not.toContain(
            (yield* (yield* BotStore).getRun(input.sourceRunId))!.threadId,
          );
          expect(system.starts).toHaveLength(3);
        }),
      ).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect("uses copied assignments and verified handoffs without duplicating work", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { feature, input } = yield* seed;
        const launches = yield* FeatureLaunchService;
        const workflows = yield* WorkflowService;
        const runner = yield* WorkflowExecutionService;
        const executions = yield* WorkflowExecutionStore;
        const botStore = yield* BotStore;
        const handoffs = yield* BotHandoffStore;
        const delegation = yield* BotHandoffService;
        const first = yield* launches.launch(input);
        expect(first.phase).toBe("attached");
        expect(first.actorId).toBe(input.actorId);
        const attached = (yield* executions.get(feature.id))!;
        expect(attached.bindings.writer?.botId).toBe(feature.botAssignments.writer);
        expect(attached.bindings.lead?.dispatchRunId).toBe(input.sourceRunId);
        expect(attached.featureContext).toContain(feature.brief);
        const snapshot = (yield* workflows.getFeatureSnapshot(feature.id, projectId))!;
        expect(snapshot.steps.find((step) => step.id === "plan")?.status).toBe("running");
        const runId = snapshot.steps.find((step) => step.id === "plan")!.botRunId!;
        const run = (yield* botStore.getRun(runId))!;
        expect(run.botId).toBe(feature.botAssignments.writer);
        expect(run.taskText).toContain(feature.brief);
        expect((yield* handoffs.getForTargetRun(runId))?.sourceRunId).toBe(
          attached.bindings.writer?.dispatchRunId,
        );
        expect(yield* launches.launch({ ...input, actorId: "session-two" })).toEqual(first);
        expect(system.starts).toHaveLength(3);
        yield* delegation.respond(
          run.threadId,
          "completed",
          encodeOutcome({ outcome: "ready", summary: "Plan reviewed" }),
        );
        yield* runner.reconcileFeature(feature.id);
        expect((yield* workflows.getFeatureSnapshot(feature.id, projectId))?.completed).toBe(true);
        expect(yield* launches.launch(input)).toEqual(first);
        expect(system.starts).toHaveLength(3);
      }).pipe(Effect.provide(system.layer));
    }),
  );

  it.effect(
    "rejects closed features, cross-project sources, and revoked grants before dispatch",
    () =>
      withDirectory((directory) => {
        const system = fixture(directory);
        return Effect.gen(function* () {
          const { feature, input } = yield* seed;
          const features = yield* FeatureService;
          const launches = yield* FeatureLaunchService;
          const bots = yield* BotService;
          expect(
            (yield* launches
              .launch({ ...input, projectId: ProjectId.make("other") })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          const foreignSource = yield* bots.createRun({
            id: "foreign-source",
            botId: "bot-captain",
            projectId: ProjectId.make("other"),
            taskText: "Other project",
          });
          expect(
            (yield* launches
              .launch({ ...input, sourceRunId: foreignSource.id })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* features.setStatus(feature.id, projectId, "closed");
          expect((yield* launches.launch(input).pipe(Effect.result))._tag).toBe("Failure");
          yield* features.setStatus(feature.id, projectId, "open");
          yield* bots.revokeDelegation(
            feature.botAssignments.lead!,
            feature.botAssignments.writer!,
          );
          expect((yield* launches.launch(input).pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* launches.get(feature.id, projectId)).toBeNull();
          expect(system.starts).toHaveLength(2);
          yield* bots.allowDelegation(feature.botAssignments.lead!, feature.botAssignments.writer!);
          yield* launches.launch(input);
          expect(yield* launches.get(feature.id, ProjectId.make("other"))).toBeNull();
          expect(
            (yield* launches
              .launch({ ...input, sourceRunId: foreignSource.id })
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(system.layer));
      }),
  );

  it.effect("recovers interrupted preparation after restart with the same runs and crew", () =>
    withDirectory((directory) =>
      Effect.gen(function* () {
        const first = fixture(directory);
        yield* Effect.gen(function* () {
          const { input, feature } = yield* seed;
          const launches = yield* FeatureLaunchService;
          first.failNextSupervisor();
          expect((yield* launches.launch(input).pipe(Effect.result))._tag).toBe("Failure");
          const pending = (yield* launches.get(feature.id, projectId))!;
          expect(pending.phase).toBe("pending");
          expect(pending.lastError).toContain("Supervisor dispatch unavailable");
          expect(
            (yield* (yield* FeatureService)
              .setStatus(feature.id, projectId, "closed")
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(first.layer));
        const restarted = fixture(directory);
        yield* Effect.gen(function* () {
          const launches = yield* FeatureLaunchService;
          yield* launches.reconcile();
          const record = (yield* launches.get("launch-feature", projectId))!;
          expect(record.phase).toBe("attached");
          expect(record.lastError).toBeNull();
          const store = yield* BotStore;
          expect(yield* store.listRunSummaries(projectId, 100)).toHaveLength(3);
          expect(restarted.starts).toHaveLength(2);
          yield* launches.reconcile();
          expect(restarted.starts).toHaveLength(2);
        }).pipe(Effect.provide(restarted.layer));
      }),
    ),
  );

  it.effect("cancels pending preparation without starting its supervisor or task", () =>
    withDirectory((directory) => {
      const system = fixture(directory);
      return Effect.gen(function* () {
        const { feature, input } = yield* seed;
        const launches = yield* FeatureLaunchService;
        system.failNextSupervisor();
        expect((yield* launches.launch(input).pipe(Effect.result))._tag).toBe("Failure");
        yield* (yield* WorkflowExecutionService).control({
          featureId: feature.id,
          projectId,
          requestId: "cancel-setup",
          actorId: "session-one",
          kind: "cancelled",
        });
        yield* launches.reconcile();
        expect((yield* launches.get(feature.id, projectId))?.phase).toBe("cancelled");
        expect(system.starts).toHaveLength(1);
        yield* (yield* BotService).reconcileRuns();
        expect(system.starts).toHaveLength(1);
        expect(
          (yield* (yield* FeatureService).setStatus(feature.id, projectId, "closed")).status,
        ).toBe("closed");
      }).pipe(Effect.provide(system.layer));
    }),
  );
});
