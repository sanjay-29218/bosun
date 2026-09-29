// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { CommandId, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import { BotService } from "../bots/BotService.ts";
import { BotStore } from "../bots/BotStore.ts";
import { BotRuntimeLive } from "../bots/runtimeLayer.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { FeatureService, FeatureServiceLive } from "./FeatureService.ts";

const projectId = ProjectId.make("workflow-feature-project");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };

describe("feature creation", () => {
  effectIt.effect("creates a feature with independent enabled bot instances exactly once", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "workflow-feature-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const orchestration = OrchestrationLayerLive;
      const botRuntime = BotRuntimeLive.pipe(Layer.provide(orchestration));
      const layer = FeatureServiceLive.pipe(
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
      }).pipe(Effect.provide(layer));
      yield* exercise.pipe(
        Effect.ensuring(
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        ),
      );
    }),
  );
});
