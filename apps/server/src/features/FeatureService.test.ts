// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { BotService } from "../bots/BotService.ts";
import { BotStore } from "../bots/BotStore.ts";
import { WorkflowRuntimeLive } from "../workflows/runtimeLayer.ts";
import { WorkflowService } from "../workflows/WorkflowService.ts";
import { WorkflowStore } from "../workflows/WorkflowStore.ts";
import { WorkflowExecutionStore } from "../workflows/WorkflowExecutionStore.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { FeatureService, FeatureServiceLive } from "./FeatureService.ts";
import { FeatureLaunchStoreLive } from "./FeatureLaunchStore.ts";

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
    | OrchestrationEngineService
  >,
) =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "feature-integration-")),
    );
    const orchestration = OrchestrationLayerLive;
    const layer = FeatureServiceLive.pipe(
      Layer.provideMerge(FeatureLaunchStoreLive),
      Layer.provideMerge(WorkflowRuntimeLive.pipe(Layer.provide(orchestration))),
      Layer.provideMerge(orchestration),
      Layer.provide(makeSqlitePersistenceLive(NodePath.join(directory, "state.sqlite"))),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "feature-test-" })),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(NodeServices.layer),
    );
    yield* Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-feature-project"),
        projectId,
        title: "Feature project",
        workspaceRoot: directory,
        createdAt: "2026-09-30T00:00:00.000Z",
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
      const botRuntime = WorkflowRuntimeLive.pipe(Layer.provide(orchestration));
      const layer = FeatureServiceLive.pipe(
        Layer.provideMerge(FeatureLaunchStoreLive),
        Layer.provideMerge(botRuntime),
        Layer.provideMerge(orchestration),
        Layer.provide(makeSqlitePersistenceLive(databasePath)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "feature-test-" })),
        Layer.provideMerge(RepositoryIdentityResolver.layer),
        Layer.provideMerge(NodeServices.layer),
      );
      const exercise = Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const bots = yield* BotService;
        const botStore = yield* BotStore;
        const features = yield* FeatureService;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("create-workflow-feature-project"),
          projectId,
          title: "Workflow feature project",
          workspaceRoot: `/tmp/${projectId}`,
          createdAt: "2026-09-29T00:00:00.000Z",
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
